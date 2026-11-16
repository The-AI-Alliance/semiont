/**
 * Minimal Streaming Tar Writer/Reader
 *
 * Creates and reads POSIX tar archives without external dependencies.
 * Tar format: 512-byte header blocks followed by data padded to 512 bytes.
 *
 * The reader accepts a Readable stream so callers can pipe from disk
 * or network without buffering the entire archive in memory first.
 */

import { createGzip, createGunzip } from 'node:zlib';
import { Readable, Writable, pipeline } from 'node:stream';
import { promisify } from 'node:util';

const pipelineAsync = promisify(pipeline);

// ── Tar Writer ──

const BLOCK_SIZE = 512;

function createTarHeader(name: string, size: number): Buffer {
  const header = Buffer.alloc(BLOCK_SIZE, 0);

  // Name (0-99)
  header.write(name.slice(0, 100), 0, 100, 'utf8');
  // Mode (100-107)
  header.write('0000644\0', 100, 8, 'utf8');
  // UID (108-115)
  header.write('0000000\0', 108, 8, 'utf8');
  // GID (116-123)
  header.write('0000000\0', 116, 8, 'utf8');
  // Size (124-135) - octal, 11 digits + null
  header.write(size.toString(8).padStart(11, '0') + '\0', 124, 12, 'utf8');
  // Mtime (136-147)
  const mtime = Math.floor(Date.now() / 1000);
  header.write(mtime.toString(8).padStart(11, '0') + '\0', 136, 12, 'utf8');
  // Checksum placeholder (148-155) - spaces during calculation
  header.write('        ', 148, 8, 'utf8');
  // Type flag (156) - '0' = regular file
  header.write('0', 156, 1, 'utf8');
  // USTAR magic (257-262)
  header.write('ustar\0', 257, 6, 'utf8');
  // USTAR version (263-264)
  header.write('00', 263, 2, 'utf8');

  // Calculate checksum
  let checksum = 0;
  for (let i = 0; i < BLOCK_SIZE; i++) {
    checksum += header[i];
  }
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'utf8');

  return header;
}

function paddingBytes(size: number): number {
  const remainder = size % BLOCK_SIZE;
  return remainder === 0 ? 0 : BLOCK_SIZE - remainder;
}

export interface TarEntry {
  name: string;
  data: Buffer;
}

/**
 * Write tar entries to a gzipped stream.
 * Entries are written sequentially as they're yielded.
 */
export async function writeTarGz(
  entries: AsyncIterable<TarEntry>,
  output: Writable,
): Promise<void> {
  const gzip = createGzip();
  const tarStream = new Readable({ read() {} });

  const pipePromise = pipelineAsync(tarStream, gzip, output);

  for await (const entry of entries) {
    const header = createTarHeader(entry.name, entry.data.length);
    tarStream.push(header);
    tarStream.push(entry.data);

    const pad = paddingBytes(entry.data.length);
    if (pad > 0) {
      tarStream.push(Buffer.alloc(pad, 0));
    }
  }

  // End-of-archive marker: two 512-byte blocks of zeros
  tarStream.push(Buffer.alloc(BLOCK_SIZE * 2, 0));
  tarStream.push(null); // End stream

  await pipePromise;
}

// ── Tar Reader ──

export interface TarReadEntry {
  name: string;
  size: number;
  data: Buffer;
}

/**
 * Decompress gzip data from a Readable stream.
 */
async function decompressStream(input: Readable): Promise<Buffer> {
  const gunzip = createGunzip();
  const chunks: Buffer[] = [];

  return new Promise<Buffer>((resolve, reject) => {
    gunzip.on('data', (chunk: Buffer) => chunks.push(chunk));
    gunzip.on('end', () => resolve(Buffer.concat(chunks)));
    gunzip.on('error', reject);

    input.on('error', reject);
    input.pipe(gunzip);
  });
}

/**
 * Parse tar entries from decompressed data.
 */
function* parseTarEntries(decompressed: Buffer): Iterable<TarReadEntry> {
  let offset = 0;

  while (offset + BLOCK_SIZE <= decompressed.length) {
    const header = decompressed.subarray(offset, offset + BLOCK_SIZE);

    // Check for end-of-archive (all zeros)
    if (header.every((b) => b === 0)) break;

    // Parse name (null-terminated)
    const nameEnd = header.indexOf(0, 0);
    const name = header.subarray(0, Math.min(nameEnd, 100)).toString('utf8');

    // Parse size (octal, 124-135)
    const sizeStr = header.subarray(124, 135).toString('utf8').trim();
    const size = parseInt(sizeStr, 8);

    offset += BLOCK_SIZE;

    // Read data
    const data = decompressed.subarray(offset, offset + size);
    offset += size;

    // Skip padding
    offset += paddingBytes(size);

    yield { name, size, data };
  }
}

/**
 * Read tar entries from a gzipped Readable stream.
 * Yields entries one at a time.
 *
 * The stream is decompressed incrementally via pipe, then tar entries
 * are parsed from the decompressed result. This avoids requiring the
 * caller to buffer the entire gzipped archive before calling.
 */
export async function* readTarGz(input: Readable): AsyncIterable<TarReadEntry> {
  const decompressed = await decompressStream(input);
  yield* parseTarEntries(decompressed);
}
