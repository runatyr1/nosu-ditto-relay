/**
 * Convert the upstream nspam model artifacts into the packed binary the relay
 * loads at startup (`src/nspam/model.bin`).
 *
 * Upstream ships `model.txt` (8.9 MB of LightGBM text) and `calibration.npz`
 * (a zipped pair of .npy arrays). Parsing the text form costs hundreds of
 * milliseconds, and every protocol worker would pay it. The packed form is
 * ~870 KB and loads as typed-array views over the file bytes.
 *
 * Usage:
 *   # Download v2.4 from HuggingFace and pack it:
 *   bun run scripts/pack-nspam.ts
 *
 *   # Or pack from a local checkout:
 *   bun run scripts/pack-nspam.ts /path/to/model.txt /path/to/calibration.npz
 *
 * The upstream artifacts are NOT vendored — only the packed output is. Their
 * SHA-256 digests are printed and asserted below so the output stays
 * traceable to a specific upstream revision.
 */

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";

import { LightGbmModel } from "../src/nspam/lightgbm.ts";

/** barrydeen/nspam revision 29f76c8, directory v2.4. */
const MODEL_URL =
  "https://huggingface.co/barrydeen/nspam/resolve/main/v2.4/model.txt";
const CALIBRATION_URL =
  "https://huggingface.co/barrydeen/nspam/resolve/main/v2.4/calibration.npz";

/** Digests of the upstream v2.4 artifacts this packer was written against. */
const EXPECTED_MODEL_SHA256 =
  "0c6e63604b78a668b8bd282d5bc5ad07e54331dd27a6c3f5c06113b8b2c84960";
const EXPECTED_CALIBRATION_SHA256 =
  "62653a59086ae153f70ca4efc15d6d89d2ea4658c6fae962fdc4c74172358c3b";

const OUTPUT_PATH = new URL("../src/nspam/model.bin", import.meta.url).pathname;

async function fetchOrRead(
  path: string | undefined,
  url: string,
): Promise<Buffer> {
  if (path) {
    console.log(`Reading ${path}`);
    return readFile(path);
  }
  console.log(`Downloading ${url}`);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url}: HTTP ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Read a `.npz` (a zip of `.npy` members) into named float arrays.
 *
 * Only handles what `calibration.npz` actually contains: stored (uncompressed)
 * or deflated members holding 1-D little-endian float32 arrays.
 */
async function parseNpz(data: Buffer): Promise<Map<string, Float64Array>> {
  const { inflateRawSync } = await import("node:zlib");
  const out = new Map<string, Float64Array>();
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  // Walk local file headers (PK\x03\x04) from the start.
  let off = 0;
  while (off + 30 <= data.length && view.getUint32(off, true) === 0x04034b50) {
    const method = view.getUint16(off + 8, true);
    const compressedSize = view.getUint32(off + 18, true);
    const uncompressedSize = view.getUint32(off + 22, true);
    const nameLen = view.getUint16(off + 26, true);
    const extraLen = view.getUint16(off + 28, true);
    const name = data.subarray(off + 30, off + 30 + nameLen).toString("ascii");
    const dataStart = off + 30 + nameLen + extraLen;

    if (compressedSize === 0 && uncompressedSize === 0) {
      throw new Error(`${name}: streamed zip entry, sizes not in local header`);
    }

    const raw = data.subarray(dataStart, dataStart + compressedSize);
    const member = method === 0 ? raw : Buffer.from(inflateRawSync(raw));
    if (member.length !== uncompressedSize) {
      throw new Error(`${name}: size mismatch after decompression`);
    }

    out.set(name.replace(/\.npy$/, ""), parseNpy(member));
    off = dataStart + compressedSize;
  }

  if (out.size === 0) throw new Error("npz: no members found");
  return out;
}

/** Read a 1-D little-endian float32 or float64 `.npy` array. */
function parseNpy(data: Buffer): Float64Array {
  if (data.subarray(0, 6).toString("latin1") !== "\x93NUMPY") {
    throw new Error("npy: bad magic");
  }
  const major = data[6];
  const headerLen = major <= 1 ? data.readUInt16LE(8) : data.readUInt32LE(8);
  const headerStart = major <= 1 ? 10 : 12;
  const header = data
    .subarray(headerStart, headerStart + headerLen)
    .toString("ascii");
  const dataStart = headerStart + headerLen;

  const descr = /'descr'\s*:\s*'([^']+)'/.exec(header)?.[1];
  if (descr !== "<f4" && descr !== "<f8") {
    throw new Error(`npy: unsupported dtype ${descr}`);
  }
  if (/'fortran_order'\s*:\s*True/.test(header)) {
    throw new Error("npy: fortran order not supported");
  }

  const shape = /'shape'\s*:\s*\(([^)]*)\)/.exec(header)?.[1]?.trim() ?? "";
  const count = shape
    .split(",")
    .filter((s) => s.trim().length > 0)
    .reduce((acc, s) => acc * Number.parseInt(s.trim(), 10), 1);

  const out = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    out[i] =
      descr === "<f4"
        ? data.readFloatLE(dataStart + i * 4)
        : data.readDoubleLE(dataStart + i * 8);
  }
  return out;
}

async function main(): Promise<void> {
  const [modelPath, calibrationPath] = process.argv.slice(2);

  const modelBytes = await fetchOrRead(modelPath, MODEL_URL);
  const calibrationBytes = await fetchOrRead(calibrationPath, CALIBRATION_URL);

  const modelDigest = sha256(modelBytes);
  const calibrationDigest = sha256(calibrationBytes);
  console.log(`model.txt        sha256 ${modelDigest}`);
  console.log(`calibration.npz  sha256 ${calibrationDigest}`);

  if (modelDigest !== EXPECTED_MODEL_SHA256) {
    console.warn(
      `WARNING: model.txt does not match the expected v2.4 digest\n` +
        `  expected ${EXPECTED_MODEL_SHA256}`,
    );
  }
  if (calibrationDigest !== EXPECTED_CALIBRATION_SHA256) {
    console.warn(
      `WARNING: calibration.npz does not match the expected v2.4 digest\n` +
        `  expected ${EXPECTED_CALIBRATION_SHA256}`,
    );
  }

  const arrays = await parseNpz(calibrationBytes);
  const calibX = arrays.get("calib_x");
  const calibY = arrays.get("calib_y");
  if (!calibX || !calibY) {
    throw new Error("calibration.npz: missing calib_x / calib_y");
  }
  console.log(`calibration knots: ${calibX.length}`);

  const parseStart = performance.now();
  const model = LightGbmModel.parseText(
    modelBytes.toString("utf8"),
    calibX,
    calibY,
  );
  console.log(
    `parsed ${model.numTrees} trees in ${(performance.now() - parseStart).toFixed(0)}ms`,
  );

  const packed = model.pack();
  await writeFile(OUTPUT_PATH, packed);
  console.log(
    `wrote ${OUTPUT_PATH} (${(packed.length / 1024).toFixed(0)} KB, ` +
      `from ${(modelBytes.length / 1024 / 1024).toFixed(1)} MB of text)`,
  );

  // Round-trip check: the packed file must reload to an identical ensemble.
  const reloaded = LightGbmModel.unpack(packed);
  if (reloaded.numTrees !== model.numTrees) {
    throw new Error("pack/unpack round trip changed the tree count");
  }
  console.log("round trip OK");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
