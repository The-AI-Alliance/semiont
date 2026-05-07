/**
 * EmbeddingStore
 *
 * Durable file-based cache for pre-computed embedding vectors.
 * Stored under .semiont/embeddings/ — committed to git alongside events,
 * but overwritten in place rather than appended.
 *
 * File layout (same 4-hex Jump Consistent Hash sharding as events):
 *
 *   .semiont/embeddings/{ab}/{cd}/{resourceId}.jsonl
 *     Line 0: { model, dimensions }                  ← model header
 *     Line N: { chunkIndex, text, embedding[] }       ← one chunk per line
 *
 *   .semiont/embeddings/{ab}/{cd}/{annotationId}.json
 *     { model, dimensions, resourceId, text, embedding[], motivation, entityTypes }
 *
 * rebuildAll() in Smelter reads these files and upserts into Qdrant without
 * calling the embedding provider — unless the stored model doesn't match the
 * configured provider, in which case the file is re-embedded and overwritten.
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import type { ResourceId, AnnotationId } from '@semiont/core';
import type { SemiontProject } from '@semiont/core/node';
import { getShardPath } from '@semiont/event-sourcing';

export interface StoredChunk {
  chunkIndex: number;
  text: string;
  embedding: number[];
}

export interface ResourceEmbeddingFile {
  model: string;
  dimensions: number;
  chunks: StoredChunk[];
}

export interface AnnotationEmbeddingFile {
  model: string;
  dimensions: number;
  resourceId: string;
  text: string;
  embedding: number[];
  motivation: string;
  entityTypes: string[];
}

export class EmbeddingStore {
  constructor(private readonly project: SemiontProject) {}

  // ── Path helpers ────────────────────────────────────────────────────────────

  private resourceFilePath(resourceId: ResourceId): string {
    const [ab, cd] = getShardPath(String(resourceId));
    return path.join(this.project.embeddingsDir, ab, cd, `${String(resourceId)}.jsonl`);
  }

  private annotationFilePath(annotationId: AnnotationId): string {
    const [ab, cd] = getShardPath(String(annotationId));
    return path.join(this.project.embeddingsDir, ab, cd, `${String(annotationId)}.json`);
  }

  // ── Resource embeddings ─────────────────────────────────────────────────────

  async writeResourceChunks(
    resourceId: ResourceId,
    model: string,
    dimensions: number,
    chunks: StoredChunk[],
  ): Promise<void> {
    const filePath = this.resourceFilePath(resourceId);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const header = JSON.stringify({ model, dimensions });
    const lines = chunks.map(c =>
      JSON.stringify({ chunkIndex: c.chunkIndex, text: c.text, embedding: c.embedding })
    );
    await fs.writeFile(filePath, [header, ...lines].join('\n') + '\n', 'utf-8');
  }

  async readResourceEmbeddings(resourceId: ResourceId): Promise<ResourceEmbeddingFile | null> {
    const filePath = this.resourceFilePath(resourceId);
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const lines = content.trim().split('\n').filter(l => l.trim());
      if (lines.length === 0) return null;
      const header = JSON.parse(lines[0]) as { model: string; dimensions: number };
      const chunks = lines.slice(1).map(l => JSON.parse(l) as StoredChunk);
      return { model: header.model, dimensions: header.dimensions, chunks };
    } catch (err: any) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }

  async deleteResourceEmbeddings(resourceId: ResourceId): Promise<void> {
    const filePath = this.resourceFilePath(resourceId);
    try {
      await fs.unlink(filePath);
    } catch (err: any) {
      if (err.code !== 'ENOENT') throw err;
    }
  }

  // ── Annotation embeddings ───────────────────────────────────────────────────

  async writeAnnotationEmbedding(
    annotationId: AnnotationId,
    resourceId: ResourceId,
    model: string,
    dimensions: number,
    text: string,
    embedding: number[],
    motivation: string,
    entityTypes: string[],
  ): Promise<void> {
    const filePath = this.annotationFilePath(annotationId);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const data: AnnotationEmbeddingFile = {
      model, dimensions,
      resourceId: String(resourceId),
      text, embedding, motivation, entityTypes,
    };
    await fs.writeFile(filePath, JSON.stringify(data), 'utf-8');
  }

  async readAnnotationEmbedding(annotationId: AnnotationId): Promise<AnnotationEmbeddingFile | null> {
    const filePath = this.annotationFilePath(annotationId);
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(content) as AnnotationEmbeddingFile;
    } catch (err: any) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }

  async deleteAnnotationEmbedding(annotationId: AnnotationId): Promise<void> {
    const filePath = this.annotationFilePath(annotationId);
    try {
      await fs.unlink(filePath);
    } catch (err: any) {
      if (err.code !== 'ENOENT') throw err;
    }
  }

  // ── Scan ────────────────────────────────────────────────────────────────────

  /**
   * Scan embeddings directory and return all resource IDs (from *.jsonl files).
   */
  async getAllResourceIds(): Promise<string[]> {
    return this.scanIds((name) => name.endsWith('.jsonl'), '.jsonl');
  }

  /**
   * Scan embeddings directory and return all annotation IDs (from *.json files).
   */
  async getAllAnnotationIds(): Promise<string[]> {
    return this.scanIds((name) => name.endsWith('.json'), '.json');
  }

  private async scanIds(
    filter: (name: string) => boolean,
    ext: string,
  ): Promise<string[]> {
    const base = this.project.embeddingsDir;
    try {
      await fs.access(base);
    } catch {
      return [];
    }

    const results: string[] = [];
    const scan = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await scan(full);
        } else if (filter(entry.name)) {
          results.push(entry.name.slice(0, -ext.length));
        }
      }
    };

    await scan(base);
    return results;
  }
}
