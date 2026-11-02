import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { isObject, isString } from '@semiont/core';
import type { SessionStorage } from '@semiont/sdk';

/**
 * One knowledge base's stored session, as the SDK's `SessionStorage` over a JSON file.
 *
 * The SDK chooses the keys and what is under them; this keeps them, and nothing else is
 * written here. Mode 0600: the file holds a refresh token.
 *
 * Opening a file that is not one of these throws, naming the file.
 */
export class FileSessionStorage implements SessionStorage {
  private readonly entries = new Map<string, string>();

  constructor(private readonly path: string) {
    if (!existsSync(path)) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'));
    } catch (cause) {
      throw new Error(`${path} is not a session file: ${cause instanceof Error ? cause.message : String(cause)}`, {
        cause,
      });
    }
    if (!isObject(parsed)) throw new Error(`${path} is not a session file`);
    for (const [key, value] of Object.entries(parsed)) {
      if (!isString(value)) throw new Error(`${path} is not a session file`);
      this.entries.set(key, value);
    }
  }

  get(key: string): string | null {
    return this.entries.get(key) ?? null;
  }

  set(key: string, value: string): void {
    this.entries.set(key, value);
    this.write();
  }

  delete(key: string): void {
    if (this.entries.delete(key)) this.write();
  }

  update(key: string, change: (stored: string | null) => string | null): void {
    const next = change(this.get(key));
    if (next === null) {
      this.delete(key);
    } else {
      this.set(key, next);
    }
  }

  subscribe(_handler: (key: string, newValue: string | null) => void): (() => void) | null {
    return null;
  }

  /** Everything stored, without its keys. */
  values(): string[] {
    return [...this.entries.values()];
  }

  /** Forget everything, and the file with it. */
  remove(): void {
    this.entries.clear();
    rmSync(this.path, { force: true });
  }

  private write(): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    writeFileSync(this.path, JSON.stringify(Object.fromEntries(this.entries)), { mode: 0o600 });
    chmodSync(this.path, 0o600); // an existing file keeps its old mode through a write
  }
}
