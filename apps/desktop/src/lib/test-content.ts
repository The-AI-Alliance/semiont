import type { IContentTransport, PutBinaryRequest } from '@semiont/core';
import { resourceId as brandResourceId } from '@semiont/sdk';

/**
 * Test-only recorder for the CONTENT seam (`yield.resource` → `putBinary`) — the one
 * transport `@semiont/sdk/testing` lets a test replace (`TestClientOptions.content`).
 * Everything BUS-shaped goes through the real client over the scriptable
 * `FaultyTransport`; this covers only byte uploads: it records each `putBinary`
 * request, replays scripted byte-progress into `onProgress`, and returns scripted
 * resource ids. Unscripted surfaces throw loudly (the `stubBackend` philosophy).
 */
export function recordingContent(config: {
  /** Resource ids returned by successive `putBinary` calls, in order. */
  resourceIds: string[];
  /** Byte-progress events replayed into each upload's `onProgress`. */
  progress?: Array<{ bytesUploaded: number; totalBytes: number }>;
}) {
  const puts: PutBinaryRequest[] = [];
  const ids = [...config.resourceIds];
  const transport: IContentTransport = {
    async putBinary(request, options) {
      puts.push(request);
      for (const p of config.progress ?? []) options?.onProgress?.(p);
      const next = ids.shift();
      if (next === undefined) throw new Error('recordingContent: no scripted resourceId left');
      return { resourceId: brandResourceId(next) };
    },
    async getBinary() {
      throw new Error('recordingContent: getBinary not scripted');
    },
    async getBinaryStream() {
      throw new Error('recordingContent: getBinaryStream not scripted');
    },
    async getResourceGraph() {
      throw new Error('recordingContent: getResourceGraph not scripted');
    },
    async getAnnotations() {
      throw new Error('recordingContent: getAnnotations not scripted');
    },
    async getAnchoredText() {
      throw new Error('recordingContent: getAnchoredText not scripted');
    },
    dispose() {},
  };
  return { transport, puts };
}
