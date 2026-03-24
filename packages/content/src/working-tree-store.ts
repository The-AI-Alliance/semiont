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
 * - register(storageUri, expectedChecksum?): Read an existing file and
 *   return its metadata (CLI path). The file is already on disk; we just
 *   verify and record it. If expectedChecksum is provided, throws on mismatch.
 *
 * Storage layout:
 *   {projectRoot}/{path-from-uri}
 *
 * For example, storageUri "file://docs/overview.md" resolves to
 *   {projectRoot}/docs/overview.md
 */

import { promises as fs } from 'fs';
import { execFileSync } from 'child_process';
import path from 'path';
import type { SemiontProject } from '@semiont/core/node';
import type { Logger } from '@semiont/core';
import { calculateChecksum, verifyChecksum } from './checksum';

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
 * Manages files in the project working tree
 */
export class WorkingTreeStore {
  private projectRoot: string;
  private logger?: Logger;

  constructor(project: SemiontProject, logger?: Logger) {
    this.projectRoot = project.root;
    this.logger = logger;
  }

  /**
   * Write content to disk at the location indicated by storageUri.
   *
   * API/GUI/AI path: caller provides bytes; file may not yet exist.
   *
   * @param content - Raw bytes to write
   * @param storageUri - file:// URI (e.g. "file://docs/overview.md")
   * @returns Stored resource metadata
   */
  async store(content: Buffer, storageUri: string): Promise<StoredResource> {
    const filePath = this.resolveUri(storageUri);
    const checksum = calculateChecksum(content);

    this.logger?.debug('Storing resource', { storageUri, byteSize: content.length });

    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content);

    this.logger?.info('Resource stored', { storageUri, checksum, byteSize: content.length });

    return {
      storageUri,
      checksum,
      byteSize: content.length,
      created: new Date().toISOString(),
    };
  }

  /**
   * Read an existing file and return its metadata.
   *
   * CLI path: the file is already on disk. We read it to compute the checksum.
   * If expectedChecksum is provided, throws ChecksumMismatchError on mismatch.
   *
   * @param storageUri - file:// URI (e.g. "file://docs/overview.md")
   * @param expectedChecksum - Optional SHA-256 to verify against
   * @returns Stored resource metadata
   * @throws ChecksumMismatchError if expectedChecksum is provided and does not match
   * @throws Error if file does not exist
   */
  async register(storageUri: string, expectedChecksum?: string): Promise<StoredResource> {
    const filePath = this.resolveUri(storageUri);

    this.logger?.debug('Registering resource', { storageUri });

    const content = await fs.readFile(filePath);
    const checksum = calculateChecksum(content);

    if (expectedChecksum !== undefined && !verifyChecksum(content, expectedChecksum)) {
      throw new ChecksumMismatchError(storageUri, expectedChecksum, checksum);
    }

    this.logger?.info('Resource registered', { storageUri, checksum, byteSize: content.length });

    return {
      storageUri,
      checksum,
      byteSize: content.length,
      created: new Date().toISOString(),
    };
  }

  /**
   * Read file content by URI.
   *
   * @param storageUri - file:// URI
   * @returns Raw bytes
   */
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

    const useGit = !options?.noGit && await this.hasGit();
    if (useGit) {
      // git mv handles both the filesystem rename and the index update
      execFileSync('git', ['mv', fromPath, toPath], { cwd: this.projectRoot });
    } else {
      await fs.rename(fromPath, toPath);
    }

    this.logger?.info('Resource moved', { fromUri, toUri });
  }

  private async hasGit(): Promise<boolean> {
    try {
      await fs.access(path.join(this.projectRoot, '.git'));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Remove a file.
   *
   * @param storageUri - file:// URI
   * @param keepFile - If true, do not delete the file (caller will handle via git rm --cached)
   */
  async remove(storageUri: string, options?: { keepFile?: boolean }): Promise<void> {
    if (options?.keepFile) {
      this.logger?.info('Resource removed from index (file kept on disk)', { storageUri });
      return;
    }

    const filePath = this.resolveUri(storageUri);
    this.logger?.debug('Removing resource', { storageUri });

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
