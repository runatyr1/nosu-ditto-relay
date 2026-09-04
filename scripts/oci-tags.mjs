// Read an OCI image layout and emit the tag map an ncontainer kind-30624 event
// needs — without a signing key or any ncontainer checkout. This is the only
// preparation `publish-container.sh` does before it hands off to `nak` for
// signing, so the sign step can go through a NIP-46 bunker (no raw nsec) while
// this stays pure, offline data-shaping.
//
//   node scripts/oci-tags.mjs <layout-dir>
//
// It (1) reads each tag the layout names from the `org.opencontainers.image.
// ref.name` annotation the builder writes, (2) synthesizes a real image index
// blob and writes it into the layout (the layout's own index.json omits a
// mediaType and so cannot itself be served as a manifest), and (3) prints, on
// stdout, a JSON object:
//
//   { "tags": [["latest","<hex>"], ["index","<hex>"]] }
//
// where each <hex> is a bare sha256 (no "sha256:" prefix) — the spelling both
// Blossom and the 30624 event use. Diagnostics go to stderr so stdout stays a
// clean, parseable contract.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OCI_INDEX = "application/vnd.oci.image.index.v1+json";

const layout = process.argv[2];
if (!layout) {
  console.error("usage: oci-tags.mjs <layout-dir>");
  process.exit(1);
}

// The layout writes digests OCI-style ("sha256:<hex>"); the event and Blossom
// name blobs by the bare hash. Only sha256 is possible on Blossom.
function bareDigest(digest) {
  const m = /^sha256:([0-9a-f]{64})$/.exec(digest ?? "");
  return m ? m[1] : null;
}

const index = JSON.parse(readFileSync(join(layout, "index.json"), "utf8"));
const tags = [];

for (const desc of index.manifests ?? []) {
  const name = desc.annotations?.["org.opencontainers.image.ref.name"];
  if (!name) continue;
  const digest = bareDigest(desc.digest);
  if (!digest) {
    console.error(`skip ${name}: '${desc.digest}' is not a sha256 digest`);
    continue;
  }
  tags.push([name, digest]);
  console.error(`tag ${name} -> ${digest} (${desc.mediaType})`);
}

// Synthesize a proper multi-platform index blob so an `index` tag resolves like
// any other manifest.
const indexDoc = JSON.stringify({
  schemaVersion: 2,
  mediaType: OCI_INDEX,
  manifests: (index.manifests ?? []).map(({ mediaType, digest, size }) => ({ mediaType, digest, size })),
});
const indexBytes = Buffer.from(indexDoc, "utf8");
const indexDigest = createHash("sha256").update(indexBytes).digest("hex");
writeFileSync(join(layout, "blobs", "sha256", indexDigest), indexBytes);
tags.push(["index", indexDigest]);
console.error(`tag index -> ${indexDigest} (${OCI_INDEX})`);

if (tags.length === 0) {
  console.error("no taggable manifests in the layout");
  process.exit(1);
}

process.stdout.write(JSON.stringify({ tags }) + "\n");
