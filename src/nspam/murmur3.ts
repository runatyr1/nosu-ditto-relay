/**
 * MurmurHash3 x86 32-bit, the hash sklearn's `HashingVectorizer` uses
 * (`sklearn.feature_extraction._hashing_fast`).
 *
 * Ported from the Kotlin reference implementation in barrydeen/wisp
 * (`app/src/main/kotlin/com/wisp/app/ml/MurmurHash3.kt`, MIT licensed),
 * which in turn matches the canonical Austin Appleby reference.
 *
 * Verified bit-for-bit against `hash_fixtures.jsonl` from the nspam model
 * repository — see murmur3.test.ts.
 */

const C1 = 0xcc9e2d51 | 0;
const C2 = 0x1b873593 | 0;
const FMIX1 = 0x85ebca6b | 0;
const FMIX2 = 0xc2b2ae35 | 0;

/**
 * Hash `data[start..end)` to a signed 32-bit integer.
 *
 * The range form exists so the feature extractor can hash n-grams straight
 * out of one UTF-8 scratch buffer instead of materializing a string and a
 * `Uint8Array` per n-gram — there are hundreds of those per note.
 *
 * `Math.imul` is what makes this correct in JS: a plain `*` on two 32-bit
 * values overflows the 53-bit mantissa and silently loses the low bits that
 * the algorithm depends on.
 */
export function hash32Range(
  data: Uint8Array,
  start: number,
  end: number,
  seed = 0,
): number {
  let h1 = seed | 0;
  const len = end - start;
  const nblocks = (len / 4) | 0;

  for (let i = 0; i < nblocks; i++) {
    const off = start + i * 4;
    let k1 =
      data[off] |
      (data[off + 1] << 8) |
      (data[off + 2] << 16) |
      (data[off + 3] << 24) |
      0;
    k1 = Math.imul(k1, C1);
    k1 = (k1 << 15) | (k1 >>> 17);
    k1 = Math.imul(k1, C2);
    h1 ^= k1;
    h1 = (h1 << 13) | (h1 >>> 19);
    h1 = (Math.imul(h1, 5) + 0xe6546b64) | 0;
  }

  const tail = start + nblocks * 4;
  let k1 = 0;
  const rem = len & 3;
  if (rem === 3) {
    k1 ^= data[tail + 2] << 16;
  }
  if (rem >= 2) {
    k1 ^= data[tail + 1] << 8;
  }
  if (rem >= 1) {
    k1 ^= data[tail];
    k1 = Math.imul(k1, C1);
    k1 = (k1 << 15) | (k1 >>> 17);
    k1 = Math.imul(k1, C2);
    h1 ^= k1;
  }

  h1 ^= len;
  h1 ^= h1 >>> 16;
  h1 = Math.imul(h1, FMIX1);
  h1 ^= h1 >>> 13;
  h1 = Math.imul(h1, FMIX2);
  h1 ^= h1 >>> 16;

  return h1 | 0;
}

/** Hash the whole of `data` to a signed 32-bit integer. */
export function hash32(data: Uint8Array, seed = 0): number {
  return hash32Range(data, 0, data.length, seed);
}
