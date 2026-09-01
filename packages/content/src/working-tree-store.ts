/**
 * WorkingTreeStore - Manages files in the project working tree
 *
 * Unlike the old content-addressed RepresentationStore, this store treats
 * the working tree (project root) as the source of truth for file content.
 * Resources are identified by their file:// URI, which is stable across
 * content changes and moves (tracked by events).
 *
 * Two write paths:
 * - store(content, storageUri): Write bytes to disk (API/GUI/AI path).
 *   Used when the file does not yet exist and the caller provides content.
 * - register(storageUri, expectedChecksum?): Adopt a file already on disk and
 *   return its metadata. The CLI path (the file arrived by other means) and
 *   the event-apply path (the Stower staging bytes an event names) both use
 *   it. Streams the file to hash it — never holds it. If expectedChecksum is
 *   provided, throws on mismatch.
 *
 * Storage layout:
 *   {projectRoot}/{path-from-uri}
 *
 * For example, storageUri "file://docs/overview.md" resolves to
 *   {projectRoot}/docs/overview.md
 */

import { promises as fs, createReadStream, createWriteStream } from 'fs';
import { execFileSync } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import path from 'path';
import type { SemiontProject } from '@semiont/core/node';
import type { Logger } from '@semiont/core';

/**
 * Result of store() or register()
 */
export interface StoredResource {
  storageUri: string;    // file:// URI (e.g. "file://docs/overview.md")
  checksum: string;      // SHA-256 hex of content
  byteSize: number;      // Size in bytes
  created: string;       // ISO 8601 timestamp
}

/**
 * sha256 + byte count over a chunk stream, held in one place because both
 * write paths need exactly this and neither may hold the file: `store` taps
 * bytes on their way to disk, `register` taps them on the way back off it.
 * Two copies would be two chances to disagree about what a checksum is.
 */
function hashingTap() {
    const hash = createHash('sha256');
    let byteSize = 0;
    return {
        update(chunk: Buffer): void {
            hash.update(chunk);
            byteSize += chunk.length;
        },
        get byteSize(): number {
            return byteSize;
        },
        digest(): string {
            return hash.digest('hex');
        },
    };
}

/**
 * Manages files in the project working tree
 */
export class WorkingTreeStore {
  private projectRoot: string;
  private gitSync: boolean;
  private logger?: Logger;

  constructor(project: SemiontProject, logger?: Logger) {
    this.projectRoot = project.root;
    this.gitSync = project.gitSync;
    this.logger = logger;
  }

  private shouldRunGit(noGit?: boolean): boolean {
    return this.gitSync && !noGit;
  }

  /**
   * Write content to disk at the location indicated by storageUri.
   *
   * API/GUI/AI path: caller provides bytes — as a Buffer it already holds, or
   * as a stream (the Archivist's write endpoint hands the request body
   * straight through, SINGLE-KB-MOUNT P2/D7: memory stays bounded by the
   * chunk, never the representation).
   *
   * Atomic either way: bytes stream into a temp file beside the target and
   * are renamed into place only once complete — and only once
   * `expectedChecksum`, when given, agrees with what actually arrived. A
   * mismatch or a torn stream leaves the target untouched (a version being
   * overwritten survives) and no temp file behind, so the Stower's `register`
   * can never find partial bytes an event names.
   *
   * @param content - Raw bytes to write, whole or streamed
   * @param storageUri - file:// URI (e.g. "file://docs/overview.md")
   * @throws ChecksumMismatchError when expectedChecksum disagrees with the body
   * @returns Stored resource metadata
   */
  async store(
    content: Buffer | Readable,
    storageUri: string,
    options?: { noGit?: boolean; expectedChecksum?: string },
  ): Promise<StoredResource> {
    const filePath = this.resolveUri(storageUri);
    const source = Buffer.isBuffer(content) ? Readable.from([content]) : content;

    this.logger?.debug('Storing resource', { storageUri });

    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.${randomUUID()}.tmp`;
    const tap = hashingTap();

    try {
      await pipeline(
        source,
        async function* (chunks: AsyncIterable<Buffer>) {
          for await (const chunk of chunks) {
            tap.update(chunk);
            yield chunk;
          }
        },
        createWriteStream(tempPath),
      );

      const checksum = tap.digest();
      const byteSize = tap.byteSize;
      if (options?.expectedChecksum !== undefined && options.expectedChecksum !== checksum) {
        throw new ChecksumMismatchError(storageUri, options.expectedChecksum, checksum);
      }
      await fs.rename(tempPath, filePath);

      if (this.shouldRunGit(options?.noGit)) {
        execFileSync('git', ['add', filePath], { cwd: this.projectRoot });
      }

      this.logger?.info('Resource stored', { storageUri, checksum, byteSize });

      return {
        storageUri,
        checksum,
        byteSize,
        created: new Date().toISOString(),
      };
    } catch (error) {
      await fs.rm(tempPath, { force: true });
      throw error;
    }
  }

  /**
   * Read an existing file and return its metadata.
   *
   * The file is already on disk; this hashes it by streaming to confirm what
   * it is, then stages it. If expectedChecksum is provided, throws
   * ChecksumMismatchError on mismatch.
   *
   * @param storageUri - file:// URI (e.g. "file://docs/overview.md")
   * @param expectedChecksum - Optional SHA-256 to verify against
   * @returns Stored resource metadata
   * @throws ChecksumMismatchError if expectedChecksum is provided and does not match
   * @throws Error if file does not exist
   */
  async register(storageUri: string, expectedChecksum?: string, options?: { noGit?: boolean }): Promise<StoredResource> {
    const filePath = this.resolveUri(storageUri);

    this.logger?.debug('Registering resource', { storageUri });

    // Hashed by streaming, never read whole. This runs on the event-apply
    // path in the SAME process that streamed the upload in, so a `readFile`
    // here would re-materialize bytes the write path was careful to keep
    // chunk-bounded — the D7 memory bound would hold only until the event
    // applied. The second hash itself is kept deliberately: it is the moment
    // the record commits to "these bytes are what this event says", and the
    // CLI path writes files this process never saw.
    const tap = hashingTap();
    for await (const chunk of createReadStream(filePath)) {
      tap.update(chunk as Buffer);
    }
    const checksum = tap.digest();

    if (expectedChecksum !== undefined && checksum !== expectedChecksum) {
      throw new ChecksumMismatchError(storageUri, expectedChecksum, checksum);
    }

    if (this.shouldRunGit(options?.noGit)) {
      execFileSync('git', ['add', filePath], { cwd: this.projectRoot });
    }

    const byteSize = tap.byteSize;
    this.logger?.info('Resource registered', { storageUri, checksum, byteSize });

    return {
      storageUri,
      checksum,
      byteSize,
      created: new Date().toISOString(),
    };
  }

  /**
   * Read file content by URI.
   *
   * @param storageUri - file:// URI
   * @returns Raw bytes
   */
  /**
   * The same bytes as `retrieve`, streamed — for the byte paths that must not
   * hold a whole representation in memory (SINGLE-KB-MOUNT D7: the Archivist
   * serves content for every reader now, so its memory cannot be bounded by
   * the largest file anyone asks for).
   *
   * Lazy by construction: the stream is created here but nothing is read
   * until the caller iterates, so a missing file surfaces as an `error` event
   * on the stream rather than a rejected promise. Callers that need the
   * distinction up front should resolve the descriptor first — which is what
   * `resolveRepresentation` does.
   */
  retrieveStream(storageUri: string): Readable {
    return createReadStream(this.resolveUri(storageUri));
  }

  async retrieve(storageUri: string): Promise<Buffer> {
    const filePath = this.resolveUri(storageUri);
    try {
      return await fs.readFile(filePath);
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        throw new Error(`Resource not found: ${storageUri}`);
      }
      throw error;
    }
  }

  /**
   * Move a file from one URI to another.
   *
   * If .git/ exists in the project root and noGit is not set, runs `git mv`.
   * Otherwise (no .git/ or noGit: true), runs fs.rename.
   *
   * @param fromUri - Current file:// URI
   * @param toUri - New file:// URI
   * @param options.noGit - Skip git mv even if .git/ is present
   */
  async move(fromUri: string, toUri: string, options?: { noGit?: boolean }): Promise<void> {
    const fromPath = this.resolveUri(fromUri);
    const toPath = this.resolveUri(toUri);

    this.logger?.debug('Moving resource', { fromUri, toUri });

    await fs.mkdir(path.dirname(toPath), { recursive: true });

    if (this.shouldRunGit(options?.noGit)) {
      // git mv handles both the filesystem rename and the index update
      execFileSync('git', ['mv', fromPath, toPath], { cwd: this.projectRoot });
    } else {
      await fs.rename(fromPath, toPath);
    }

    this.logger?.info('Resource moved', { fromUri, toUri });
  }

  /**
   * Remove a file from the working tree.
   *
   * If .git/ exists and noGit is not set:
   *   - keepFile false (default): runs `git rm` (removes from index and disk)
   *   - keepFile true: runs `git rm --cached` (removes from index only, file stays on disk)
   * If no .git/ or noGit: true:
   *   - keepFile false: runs fs.unlink
   *   - keepFile true: no-op on filesystem
   *
   * @param storageUri - file:// URI
   * @param options.noGit - Skip git rm even if .git/ is present
   * @param options.keepFile - Remove from git index only; leave file on disk
   */
  async remove(storageUri: string, options?: { noGit?: boolean; keepFile?: boolean }): Promise<void> {
    const filePath = this.resolveUri(storageUri);
    const keepFile = options?.keepFile ?? false;

    this.logger?.debug('Removing resource', { storageUri, keepFile });

    const useGit = this.shouldRunGit(options?.noGit);

    if (useGit) {
      const gitArgs = keepFile
        ? ['rm', '--cached', filePath]
        : ['rm', filePath];
      execFileSync('git', gitArgs, { cwd: this.projectRoot });
      this.logger?.info('Resource removed', { storageUri, keepFile, git: true });
      return;
    }

    if (keepFile) {
      this.logger?.info('Resource removed from index (file kept on disk)', { storageUri });
      return;
    }

    try {
      await fs.unlink(filePath);
      this.logger?.info('Resource removed', { storageUri });
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        this.logger?.warn('Resource file already absent', { storageUri });
        return;
      }
      throw error;
    }
  }

  /**
   * Convert a file:// URI to an absolute filesystem path.
   *
   * "file://docs/overview.md" → "{projectRoot}/docs/overview.md"
   *
   * @param storageUri - file:// URI
   * @returns Absolute path
   */
  resolveUri(storageUri: string): string {
    if (!storageUri.startsWith('file://')) {
      throw new Error(`Invalid storage URI (must start with file://): ${storageUri}`);
    }
    const relativePath = storageUri.slice('file://'.length);
    return path.join(this.projectRoot, relativePath);
  }
}

/**
 * Thrown when a registered file's checksum does not match the expected value.
 * This indicates the file on disk differs from what was recorded (e.g. modified
 * after staging, or wrong file path provided).
 */
export class ChecksumMismatchError extends Error {
  constructor(
    readonly storageUri: string,
    readonly expected: string,
    readonly actual: string,
  ) {
    super(
      `Checksum mismatch for ${storageUri}: expected ${expected.slice(0, 8)}... but got ${actual.slice(0, 8)}...\n` +
      `The file on disk differs from the recorded checksum. Has it been modified since staging?`
    );
    this.name = 'ChecksumMismatchError';
  }
}
