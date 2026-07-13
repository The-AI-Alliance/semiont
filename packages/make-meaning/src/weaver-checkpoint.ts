/**
 * WeaverCheckpoint — the Weaver's persisted per-resource applied-sequence
 * map (WEAVER-ISOLATION P3, D1 = checkpointed replay).
 *
 * `catchUp()` seeds `lastProcessed` from it and replays only the gap;
 * `noteApplied` marks it dirty and the Weaver flushes on an interval and
 * on stop. Losing the file is safe by construction: the next catch-up
 * degrades to a full replay through the pipeline, which the idempotent
 * folds (P1) absorb — the checkpoint is an optimization, never a
 * correctness input. A checkpoint AHEAD of the log (restore rewound
 * history) is detected per resource and answered with a rebuild.
 *
 * Lives in the project stateDir in-process; a container volume path once
 * the Weaver runs standalone (P4).
 */

import { promises as fs } from 'fs';
import * as path from 'path';

export interface WeaverCheckpoint {
  /** Persisted map, or `{}` when absent/unreadable (degrade to full replay). */
  load(): Promise<Record<string, number>>;
  save(applied: Record<string, number>): Promise<void>;
}

export class FileWeaverCheckpoint implements WeaverCheckpoint {
  constructor(private readonly filePath: string) {}

  async load(): Promise<Record<string, number>> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf-8');
      const parsed: unknown = JSON.parse(raw);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      const map: Record<string, number> = {};
      for (const [rid, seq] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof seq === 'number' && Number.isFinite(seq)) map[rid] = seq;
      }
      return map;
    } catch {
      // Absent or corrupt — either way the answer is a full replay, not a crash.
      return {};
    }
  }

  async save(applied: Record<string, number>): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    // Write-then-rename so a crash mid-write leaves the previous checkpoint
    // intact rather than a truncated file.
    const tmp = `${this.filePath}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(applied), 'utf-8');
    await fs.rename(tmp, this.filePath);
  }
}
