/**
 * Files in the project working tree, addressed by file:// URI —
 * "file://docs/overview.md" is {projectRoot}/docs/overview.md.
 *
 * `store` writes bytes the caller supplies; `register` adopts a file already
 * on disk. Both stream to hash, neither holds a representation in memory.
 */

import { promises as fs, createReadStream, createWriteStream } from 'fs';
import { createHash, randomUUID } from 'crypto';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import path from 'path';
import type { SemiontProject } from '@semiont/core/node';
import type { Logger, StoredResource } from '@semiont/core';
import { createStager, type Stager, type StagerOptions } from './git-staging.js';


/** sha256 + byte count over a chunk stream — one definition for both write paths. */
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

export class WorkingTreeStore {
  private projectRoot: string;
  private gitSync: boolean;
  private logger?: Logger;

  private _stager?: Stager;
  private readonly staging: StagerOptions;

  /** `staging` is policy — how stale the index may get is the caller's call. */
  constructor(project: SemiontProject, logger?: Logger, staging: StagerOptions = {}) {
    this.projectRoot = project.root;
    this.gitSync = project.gitSync;
    this.logger = logger;
    this.staging = staging;
  }

  /** Created on first use — importers of this package may never stage. */
  private stager(): Stager {
    if (!this._stager) this._stager = createStager(this.projectRoot, this.staging);
    return this._stager;
  }

  /** Stage everything pending now — for a caller that wants the index current. */
  flushStaging(): Promise<void> {
    return this._stager ? this._stager.flush() : Promise.resolve();
  }

  /** Drain and stop. A stopped process must leave nothing unstaged. */
  async dispose(): Promise<void> {
    if (this._stager) await this._stager.dispose();
  }

  private shouldRunGit(noGit?: boolean): boolean {
    return this.gitSync && !noGit;
  }

  /**
   * Write bytes to the path storageUri names, whole or streamed.
   *
   * Atomic: bytes land in a temp file and are renamed into place only once
   * complete and once `expectedChecksum`, when given, agrees. A mismatch or a
   * torn stream leaves the target untouched, so `register` can never find
   * partial bytes an event names.
   *
   * @throws ChecksumMismatchError when expectedChecksum disagrees with the body
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
        this.stager().add(filePath);
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
   * Adopt a file already on disk: stream it to hash it, then stage it.
   *
   * @throws ChecksumMismatchError if expectedChecksum is given and disagrees
   */
  async register(storageUri: string, expectedChecksum?: string, options?: { noGit?: boolean }): Promise<StoredResource> {
    const filePath = this.resolveUri(storageUri);

    this.logger?.debug('Registering resource', { storageUri });

    // Streamed, never read whole: this runs in the same process that streamed
    // the upload in, and a `readFile` would undo that bound.
    const tap = hashingTap();
    for await (const chunk of createReadStream(filePath)) {
      tap.update(chunk as Buffer);
    }
    const checksum = tap.digest();

    if (expectedChecksum !== undefined && checksum !== expectedChecksum) {
      throw new ChecksumMismatchError(storageUri, expectedChecksum, checksum);
    }

    if (this.shouldRunGit(options?.noGit)) {
      this.stager().add(filePath);
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
   * The same bytes as `retrieve`, streamed. Lazy: a missing file surfaces as
   * an `error` event on the stream, not a rejected promise — callers needing
   * that up front should resolve the descriptor first.
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

  /** `git mv` when the project syncs git, `fs.rename` otherwise. */
  async move(fromUri: string, toUri: string, options?: { noGit?: boolean }): Promise<void> {
    const fromPath = this.resolveUri(fromUri);
    const toPath = this.resolveUri(toUri);

    this.logger?.debug('Moving resource', { fromUri, toUri });

    await fs.mkdir(path.dirname(toPath), { recursive: true });

    if (this.shouldRunGit(options?.noGit)) {
      await this.stager().run(['mv', fromPath, toPath]);
    } else {
      await fs.rename(fromPath, toPath);
    }

    this.logger?.info('Resource moved', { fromUri, toUri });
  }

  /** @param options.keepFile - Drop from the index only; leave the file on disk. */
  async remove(storageUri: string, options?: { noGit?: boolean; keepFile?: boolean }): Promise<void> {
    const filePath = this.resolveUri(storageUri);
    const keepFile = options?.keepFile ?? false;

    this.logger?.debug('Removing resource', { storageUri, keepFile });

    const useGit = this.shouldRunGit(options?.noGit);

    if (useGit) {
      const gitArgs = keepFile
        ? ['rm', '--cached', filePath]
        : ['rm', filePath];
      await this.stager().run(gitArgs);
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

  resolveUri(storageUri: string): string {
    if (!storageUri.startsWith('file://')) {
      throw new Error(`Invalid storage URI (must start with file://): ${storageUri}`);
    }
    const relativePath = storageUri.slice('file://'.length);
    return path.join(this.projectRoot, relativePath);
  }
}

/** The file on disk is not the file the checksum names. */
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
