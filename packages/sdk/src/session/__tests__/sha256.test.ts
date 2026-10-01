/**
 * The session's own SHA-256, held to FIPS 180-4's vectors and to the
 * platform's implementation.
 *
 * It exists because `crypto.subtle` is withheld from a page that is not a
 * secure context, and a sign-in's PKCE challenge is a SHA-256. Production
 * hashes one length only, a 64-character verifier, so that length and the
 * padding boundaries around a block are where the equivalence run looks
 * hardest.
 */
import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sha256 } from '../sha256';

const hex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const ascii = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('sha256', () => {
  it.each([
    ['the empty message', '', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['"abc"', 'abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    [
      'the 448-bit message',
      'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    ],
    [
      'the 896-bit message',
      'abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu',
      'cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1',
    ],
  ])('hashes %s as FIPS 180-4 states', (_name, message, digest) => {
    expect(hex(sha256(ascii(message)))).toBe(digest);
  });

  it('hashes one million "a"s as FIPS 180-4 states', () => {
    expect(hex(sha256(ascii('a'.repeat(1_000_000))))).toBe('cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0');
  });

  it('agrees with the platform at every length across three blocks, the padding boundaries included', () => {
    // 55 bytes is the longest message whose padding fits its block; 56 spills
    // the length into another; 64 is a whole block, and the length production hashes.
    for (let length = 0; length <= 192; length++) {
      const message = randomBytes(length);
      expect(hex(sha256(message)), `${length} bytes`).toBe(createHash('sha256').update(message).digest('hex'));
    }
  });

  it('agrees with the platform on random messages of random lengths', () => {
    for (let run = 0; run < 200; run++) {
      const message = randomBytes(randomBytes(2).readUInt16BE(0) % 5000);
      expect(hex(sha256(message)), `${message.length} bytes`).toBe(createHash('sha256').update(message).digest('hex'));
    }
  });

  it('leaves its input as it was', () => {
    const message = ascii('abc');
    sha256(message);
    expect(Array.from(message)).toEqual([0x61, 0x62, 0x63]);
  });
});
