/**
 * Tar Writer/Reader Tests
 *
 * Tests the minimal POSIX tar implementation used by backup and snapshot
 * archives. Verifies write→read round-trip integrity, multi-entry archives,
 * empty data, binary data, and padding alignment.
 */

import { describe, it, expect } from 'vitest';
import { Readable, Writable } from 'node:stream';
import { writeTarGz, readTarGz, type TarEntry, type TarReadEntry } from '../../exchange/tar';

/**
 * Create a binary-mode Readable from a Buffer.
 * Unlike Readable.from(buffer), this does NOT use object mode,
 * so downstream pipe targets receive Buffer chunks.
 */
function bufferToReadable(buf: Buffer): Readable {
  const stream = new Readable({ read() {} });
  stream.push(buf);
  stream.push(null);
  return stream;
}

/**
 * Collect a Writable stream's output into a single Buffer.
 */
function collectWritable(): { writable: Writable; promise: Promise<Buffer> } {
  const chunks: Buffer[] = [];
  const writable = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk);
      callback();
    },
  });
  const promise = new Promise<Buffer>((resolve, reject) => {
    writable.on('finish', () => resolve(Buffer.concat(chunks)));
    writable.on('error', reject);
  });
  return { writable, promise };
}

/**
 * Write entries to tar.gz, then read them back.
 */
async function roundTrip(entries: TarEntry[]): Promise<TarReadEntry[]> {
  const { writable, promise } = collectWritable();

  async function* generate(): AsyncIterable<TarEntry> {
    for (const e of entries) yield e;
  }

  await writeTarGz(generate(), writable);
  const archive = await promise;

  const result: TarReadEntry[] = [];
  for await (const entry of readTarGz(bufferToReadable(archive))) {
    result.push(entry);
  }
  return result;
}

describe('tar', () => {
  describe('writeTarGz + readTarGz round-trip', () => {
    it('round-trips a single text entry', async () => {
      const data = Buffer.from('hello world', 'utf8');
      const result = await roundTrip([{ name: 'test.txt', data }]);

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('test.txt');
      expect(result[0].data.toString('utf8')).toBe('hello world');
      expect(result[0].size).toBe(data.length);
    });

    it('round-trips multiple entries', async () => {
      const entries: TarEntry[] = [
        { name: 'manifest.jsonl', data: Buffer.from('{"format":"test"}\n', 'utf8') },
        { name: 'events/system.jsonl', data: Buffer.from('{"event":"one"}\n{"event":"two"}\n', 'utf8') },
        { name: 'content/abc123.md', data: Buffer.from('# Hello\n\nSome content here.\n', 'utf8') },
      ];
      const result = await roundTrip(entries);

      expect(result).toHaveLength(3);
      expect(result[0].name).toBe('manifest.jsonl');
      expect(result[1].name).toBe('events/system.jsonl');
      expect(result[2].name).toBe('content/abc123.md');

      for (let i = 0; i < entries.length; i++) {
        expect(result[i].data.toString('utf8')).toBe(entries[i].data.toString('utf8'));
        expect(result[i].size).toBe(entries[i].data.length);
      }
    });

    it('round-trips an empty entry (zero-byte file)', async () => {
      const result = await roundTrip([{ name: 'empty.txt', data: Buffer.alloc(0) }]);

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('empty.txt');
      expect(result[0].size).toBe(0);
      expect(result[0].data.length).toBe(0);
    });

    it('round-trips binary data', async () => {
      const binary = Buffer.from([0x00, 0xff, 0x1f, 0x8b, 0xde, 0xad, 0xbe, 0xef]);
      const result = await roundTrip([{ name: 'content/deadbeef.bin', data: binary }]);

      expect(result).toHaveLength(1);
      expect(Buffer.compare(result[0].data, binary)).toBe(0);
    });

    it('handles entries whose size is an exact multiple of 512', async () => {
      const data = Buffer.alloc(512, 0x42);
      const result = await roundTrip([{ name: 'exact.bin', data }]);

      expect(result).toHaveLength(1);
      expect(result[0].size).toBe(512);
      expect(result[0].data.every((b) => b === 0x42)).toBe(true);
    });

    it('handles entries whose size is NOT a multiple of 512 (padding)', async () => {
      const data = Buffer.alloc(700, 0x41);
      const result = await roundTrip([{ name: 'padded.bin', data }]);

      expect(result).toHaveLength(1);
      expect(result[0].size).toBe(700);
      expect(result[0].data.every((b) => b === 0x41)).toBe(true);
    });

    it('preserves entry order', async () => {
      const names = Array.from({ length: 10 }, (_, i) => `file-${String(i).padStart(2, '0')}.txt`);
      const entries: TarEntry[] = names.map((name) => ({
        name,
        data: Buffer.from(`content of ${name}`, 'utf8'),
      }));

      const result = await roundTrip(entries);
      expect(result.map((e) => e.name)).toEqual(names);
    });

    it('handles large-ish entries (64KB)', async () => {
      const data = Buffer.alloc(65536, 0x58);
      const result = await roundTrip([{ name: 'large.bin', data }]);

      expect(result).toHaveLength(1);
      expect(result[0].size).toBe(65536);
      expect(Buffer.compare(result[0].data, data)).toBe(0);
    });
  });

  describe('readTarGz from Readable stream', () => {
    it('reads from a Readable piped buffer', async () => {
      // First write an archive
      const { writable, promise } = collectWritable();
      async function* gen(): AsyncIterable<TarEntry> {
        yield { name: 'a.txt', data: Buffer.from('aaa') };
        yield { name: 'b.txt', data: Buffer.from('bbb') };
      }
      await writeTarGz(gen(), writable);
      const archive = await promise;

      // Read it back via Readable.from
      const entries: TarReadEntry[] = [];
      for await (const e of readTarGz(bufferToReadable(archive))) {
        entries.push(e);
      }
      expect(entries).toHaveLength(2);
      expect(entries[0].data.toString()).toBe('aaa');
      expect(entries[1].data.toString()).toBe('bbb');
    });
  });
});
