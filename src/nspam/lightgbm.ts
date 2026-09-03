/**
 * Minimal LightGBM inference: enough to evaluate the nspam model and nothing
 * more.
 *
 * The model is 500 binary-objective trees of 63 leaves. Every split in it has
 * `decision_type=2` — numerical, no categorical splits, `missing_type=None` —
 * so a node is just `x <= threshold ? left : right`, and the features are
 * never NaN. That reduces prediction to a flat array walk.
 *
 * Trees are stored as one set of flat typed arrays with per-tree offsets
 * rather than 500 objects, so the hot loop touches five contiguous buffers.
 */

/** Magic bytes identifying a packed nspam model file. */
export const PACK_MAGIC = 0x4d50534e; // "NSPM" little-endian
/** Packed format version. Bump on any layout change. */
export const PACK_VERSION = 1;

const HEADER_BYTES = 32;

/** A parsed LightGBM ensemble plus its isotonic calibration table. */
export class LightGbmModel {
  constructor(
    private readonly treeNodeOffsets: Int32Array,
    private readonly treeLeafOffsets: Int32Array,
    private readonly splitFeature: Int32Array,
    private readonly leftChild: Int32Array,
    private readonly rightChild: Int32Array,
    private readonly threshold: Float64Array,
    private readonly leafValue: Float64Array,
    readonly calibX: Float64Array,
    readonly calibY: Float64Array,
  ) {}

  /** Number of trees in the ensemble. */
  get numTrees(): number {
    return this.treeNodeOffsets.length - 1;
  }

  /** Sum of leaf values across all trees — the pre-sigmoid margin. */
  rawMargin(features: Float64Array): number {
    const {
      treeNodeOffsets,
      treeLeafOffsets,
      splitFeature,
      leftChild,
      rightChild,
      threshold,
      leafValue,
    } = this;
    const numTrees = treeNodeOffsets.length - 1;

    let sum = 0;
    for (let t = 0; t < numTrees; t++) {
      const base = treeNodeOffsets[t];
      let node = 0;
      while (node >= 0) {
        const i = base + node;
        node =
          features[splitFeature[i]] <= threshold[i]
            ? leftChild[i]
            : rightChild[i];
      }
      sum += leafValue[treeLeafOffsets[t] - node - 1];
    }
    return sum;
  }

  /** Sigmoid of the raw margin — the uncalibrated probability. */
  rawScore(features: Float64Array): number {
    return 1 / (1 + Math.exp(-this.rawMargin(features)));
  }

  /** Piecewise-linear interpolation through the calibration knots. */
  calibrate(raw: number): number {
    const { calibX, calibY } = this;
    if (calibX.length === 0) return raw;
    if (raw <= calibX[0]) return calibY[0];
    if (raw >= calibX[calibX.length - 1]) return calibY[calibY.length - 1];
    for (let i = 0; i < calibX.length - 1; i++) {
      if (raw >= calibX[i] && raw < calibX[i + 1]) {
        const t = (raw - calibX[i]) / (calibX[i + 1] - calibX[i]);
        return calibY[i] + t * (calibY[i + 1] - calibY[i]);
      }
    }
    return calibY[calibY.length - 1];
  }

  // -------------------------------------------------------------------------
  // Packed binary format
  //
  // Startup cost matters here: every protocol worker loads the model, and
  // parsing the 9 MB upstream `model.txt` takes hundreds of milliseconds per
  // worker. The packed form is read with typed-array views over the file
  // bytes, which is effectively free.
  //
  //   u32 magic, u32 version, u32 numTrees, u32 numNodes,
  //   u32 numLeaves, u32 numCalib, u64 padding
  //   i32[numTrees + 1] treeNodeOffsets
  //   i32[numTrees + 1] treeLeafOffsets
  //   i32[numNodes]     splitFeature
  //   i32[numNodes]     leftChild
  //   i32[numNodes]     rightChild
  //   (pad to 8)
  //   f64[numNodes]     threshold
  //   f64[numLeaves]    leafValue
  //   f64[numCalib]     calibX
  //   f64[numCalib]     calibY
  // -------------------------------------------------------------------------

  /** Serialize to the packed binary format. */
  pack(): Uint8Array {
    const numTrees = this.numTrees;
    const numNodes = this.splitFeature.length;
    const numLeaves = this.leafValue.length;
    const numCalib = this.calibX.length;

    const i32Bytes = ((numTrees + 1) * 2 + numNodes * 3) * 4;
    const f64Start = align8(HEADER_BYTES + i32Bytes);
    const total = f64Start + (numNodes + numLeaves + numCalib * 2) * 8;

    const buf = new ArrayBuffer(total);
    const view = new DataView(buf);
    view.setUint32(0, PACK_MAGIC, true);
    view.setUint32(4, PACK_VERSION, true);
    view.setUint32(8, numTrees, true);
    view.setUint32(12, numNodes, true);
    view.setUint32(16, numLeaves, true);
    view.setUint32(20, numCalib, true);

    let off = HEADER_BYTES;
    for (const arr of [
      this.treeNodeOffsets,
      this.treeLeafOffsets,
      this.splitFeature,
      this.leftChild,
      this.rightChild,
    ]) {
      new Int32Array(buf, off, arr.length).set(arr);
      off += arr.length * 4;
    }

    off = f64Start;
    for (const arr of [
      this.threshold,
      this.leafValue,
      this.calibX,
      this.calibY,
    ]) {
      new Float64Array(buf, off, arr.length).set(arr);
      off += arr.length * 8;
    }

    return new Uint8Array(buf);
  }

  /** Read the packed binary format. */
  static unpack(bytes: Uint8Array): LightGbmModel {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(0, true) !== PACK_MAGIC) {
      throw new Error("nspam: not a packed model file (bad magic)");
    }
    const version = view.getUint32(4, true);
    if (version !== PACK_VERSION) {
      throw new Error(
        `nspam: packed model version ${version}, expected ${PACK_VERSION}`,
      );
    }
    const numTrees = view.getUint32(8, true);
    const numNodes = view.getUint32(12, true);
    const numLeaves = view.getUint32(16, true);
    const numCalib = view.getUint32(20, true);

    // Typed-array views need their own alignment relative to the underlying
    // buffer, which a `Bun.file()` read does not guarantee. Copy when the
    // bytes do not start on an 8-byte boundary.
    const base =
      bytes.byteOffset % 8 === 0 ? bytes : new Uint8Array(bytes.slice());
    const buf = base.buffer;
    const origin = base.byteOffset;

    let off = origin + HEADER_BYTES;
    const readI32 = (len: number): Int32Array => {
      const arr = new Int32Array(buf, off, len);
      off += len * 4;
      return arr;
    };

    const treeNodeOffsets = readI32(numTrees + 1);
    const treeLeafOffsets = readI32(numTrees + 1);
    const splitFeature = readI32(numNodes);
    const leftChild = readI32(numNodes);
    const rightChild = readI32(numNodes);

    off = origin + align8(off - origin);
    const readF64 = (len: number): Float64Array => {
      const arr = new Float64Array(buf, off, len);
      off += len * 8;
      return arr;
    };

    const threshold = readF64(numNodes);
    const leafValue = readF64(numLeaves);
    const calibX = readF64(numCalib);
    const calibY = readF64(numCalib);

    const model = new LightGbmModel(
      treeNodeOffsets,
      treeLeafOffsets,
      splitFeature,
      leftChild,
      rightChild,
      threshold,
      leafValue,
      calibX,
      calibY,
    );
    model.validate();
    return model;
  }

  /**
   * Check that every tree is a finite, well-formed binary tree.
   *
   * {@link rawMargin} walks `while (node >= 0)` with no iteration bound, so a
   * corrupted or tampered model whose child pointers form a cycle would hang
   * the calling thread outright — and on this relay that thread owns every
   * connection assigned to it. Validating once at load makes the hot loop
   * safe to leave unguarded.
   *
   * Costs one pass over ~31k nodes at startup.
   */
  validate(): void {
    const numTrees = this.numTrees;
    if (numTrees === 0) throw new Error("nspam: model has no trees");
    if (this.calibX.length !== this.calibY.length) {
      throw new Error("nspam: calibration knot arrays differ in length");
    }

    for (let t = 0; t < numTrees; t++) {
      const nodeBase = this.treeNodeOffsets[t];
      const nodeEnd = this.treeNodeOffsets[t + 1];
      const leafBase = this.treeLeafOffsets[t];
      const leafEnd = this.treeLeafOffsets[t + 1];
      const nodeCount = nodeEnd - nodeBase;
      const leafCount = leafEnd - leafBase;

      if (nodeCount <= 0 || leafCount <= 0) {
        throw new Error(`nspam: tree ${t} is empty`);
      }

      // A well-formed binary tree is reached exactly once per node from the
      // root, so a visited set doubles as the cycle check.
      const visited = new Uint8Array(nodeCount);
      const stack = [0];
      while (stack.length > 0) {
        const node = stack.pop() as number;
        if (node < 0 || node >= nodeCount) {
          throw new Error(`nspam: tree ${t} has out-of-range node ${node}`);
        }
        if (visited[node]) {
          throw new Error(`nspam: tree ${t} is cyclic at node ${node}`);
        }
        visited[node] = 1;

        const i = nodeBase + node;
        const feature = this.splitFeature[i];
        if (feature < 0) {
          throw new Error(`nspam: tree ${t} has negative split feature`);
        }
        for (const child of [this.leftChild[i], this.rightChild[i]]) {
          if (child >= 0) {
            stack.push(child);
          } else {
            const leaf = -child - 1;
            if (leaf >= leafCount) {
              throw new Error(
                `nspam: tree ${t} references leaf ${leaf} of ${leafCount}`,
              );
            }
          }
        }
      }
    }
  }

  /**
   * Parse LightGBM's native text format.
   *
   * Only used by `scripts/pack-nspam.ts`; the relay loads the packed form.
   */
  static parseText(
    text: string,
    calibX: Float64Array,
    calibY: Float64Array,
  ): LightGbmModel {
    const splitFeature: number[] = [];
    const leftChild: number[] = [];
    const rightChild: number[] = [];
    const threshold: number[] = [];
    const leafValue: number[] = [];
    const treeNodeOffsets: number[] = [0];
    const treeLeafOffsets: number[] = [0];

    let current: Map<string, string> | null = null;

    const flush = (): void => {
      if (!current) return;
      const nodes = parseNumbers(field(current, "split_feature"));
      const thr = parseNumbers(field(current, "threshold"));
      const left = parseNumbers(field(current, "left_child"));
      const right = parseNumbers(field(current, "right_child"));
      const leaves = parseNumbers(field(current, "leaf_value"));

      const decisionTypes = current.get("decision_type");
      if (decisionTypes) {
        for (const d of parseNumbers(decisionTypes)) {
          // bit 0 set = categorical split; bits 2-3 = missing type. The walker
          // handles neither, so refuse rather than predict silently-wrong.
          if ((d & 1) !== 0 || d >> 2 !== 0) {
            throw new Error(
              `nspam: unsupported decision_type ${d}; the walker only handles plain numerical splits`,
            );
          }
        }
      }

      for (let i = 0; i < nodes.length; i++) {
        splitFeature.push(nodes[i]);
        threshold.push(thr[i]);
        leftChild.push(left[i]);
        rightChild.push(right[i]);
      }
      for (const v of leaves) leafValue.push(v);

      treeNodeOffsets.push(splitFeature.length);
      treeLeafOffsets.push(leafValue.length);
      current = null;
    };

    for (const rawLine of text.split("\n")) {
      const line = rawLine.trim();
      if (line.startsWith("Tree=")) {
        flush();
        current = new Map();
      } else if (line === "end of trees") {
        flush();
        break;
      } else if (current) {
        const eq = line.indexOf("=");
        if (eq > 0) current.set(line.slice(0, eq), line.slice(eq + 1));
      }
    }
    flush();

    return new LightGbmModel(
      Int32Array.from(treeNodeOffsets),
      Int32Array.from(treeLeafOffsets),
      Int32Array.from(splitFeature),
      Int32Array.from(leftChild),
      Int32Array.from(rightChild),
      Float64Array.from(threshold),
      Float64Array.from(leafValue),
      calibX,
      calibY,
    );
  }
}

function align8(n: number): number {
  return (n + 7) & ~7;
}

function field(map: Map<string, string>, key: string): string {
  const value = map.get(key);
  if (value === undefined) throw new Error(`nspam: tree missing ${key}`);
  return value;
}

function parseNumbers(s: string): number[] {
  const out: number[] = [];
  for (const part of s.split(" ")) {
    if (part.length > 0) out.push(Number(part));
  }
  return out;
}
