/**
 * SHA-256 (FIPS 180-4).
 *
 * The platform's own is `crypto.subtle.digest`. It answers later, where the
 * id of an annotation is worked out at once (`annotation-id.ts`); and a
 * browser withholds `crypto.subtle` from a page that is not a secure context,
 * one served over plain http from any host but localhost, where a sign-in
 * still has to compute its PKCE challenge (`@semiont/sdk`'s session layer:
 * the launcher registers such an origin for the Browser, the host's LAN
 * address). This is the one implementation, used in every context: a branch
 * that preferred the platform's where it exists would be a second
 * implementation of one hash, run only where nobody tests.
 *
 * Nothing secret is hashed here. An id is a public derivation of what an
 * annotation is, and a challenge of a value the client sends anyway, so a
 * wrong digest cannot leak anything: it fails where it can be seen, in the
 * id's case table and in the issuer's refusal of the code exchange.
 */

/** The first 32 bits of the fractional parts of the cube roots of the first 64 primes. */
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));

export function sha256(message: Uint8Array): Uint8Array {
  // Padding: a 1 bit, zeros, then the message's length in bits as 64 bits,
  // big-endian, ending on a block boundary.
  const padded = new Uint8Array((Math.floor((message.length + 8) / 64) + 1) * 64);
  padded.set(message);
  padded[message.length] = 0x80;
  const blocks = new DataView(padded.buffer);
  const bits = message.length * 8;
  blocks.setUint32(padded.length - 8, Math.floor(bits / 0x1_0000_0000));
  blocks.setUint32(padded.length - 4, bits >>> 0);

  // The first 32 bits of the fractional parts of the square roots of the first 8 primes.
  let [h0, h1, h2, h3, h4, h5, h6, h7] = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const w = new Uint32Array(64);

  for (let block = 0; block < padded.length; block += 64) {
    for (let t = 0; t < 16; t++) w[t] = blocks.getUint32(block + t * 4);
    for (let t = 16; t < 64; t++) {
      const w15 = w[t - 15]!;
      const w2 = w[t - 2]!;
      const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3);
      const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10);
      w[t] = w[t - 16]! + s0 + w[t - 7]! + s1;
    }

    let [a, b, c, d, e, f, g, h] = [h0, h1, h2, h3, h4, h5, h6, h7];
    for (let t = 0; t < 64; t++) {
      const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[t]! + w[t]!) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  const digest = new Uint8Array(32);
  const words = new DataView(digest.buffer);
  [h0, h1, h2, h3, h4, h5, h6, h7].forEach((word, i) => words.setUint32(i * 4, word));
  return digest;
}
