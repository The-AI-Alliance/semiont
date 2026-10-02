/**
 * An upload where there is no `XMLHttpRequest`: Node, as a worker, a script
 * or the CLI runs it. Real ky against a real server, because what is held
 * here is what reaches the connection and when: an upload's progress is how
 * much the connection has taken, a cancelled upload's connection is closed,
 * and neither can be seen through a mocked `ky.post`.
 *
 * The browser's path is `http-content-transport.xhr.test.ts`.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, test } from 'vitest';
import { accessToken, baseUrl, type SemiontError } from '@semiont/core';
import { HttpContentTransport } from '../http-content-transport';
import { HttpTransport } from '../http-transport';

interface Received {
  headers: IncomingMessage['headers'];
  /** How much of the body has been read off the connection. */
  bytes: number;
  /** The whole body, once it has all arrived. */
  body?: Buffer;
  /** The client's connection has closed. */
  closed: boolean;
}

type Answer = (request: IncomingMessage, response: ServerResponse, received: Received, nth: number) => void;

/** Reads the body and answers 202 with an id, as the gateway does. */
const accepts: Answer = (_request, response) => {
  response.writeHead(202, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ resourceId: 'uploaded' }));
};

let server: Server | undefined;

/** A gateway that takes each upload's body, unless `reads` is false, and then does what `answer` does. */
async function gateway(answer: Answer, reads = true): Promise<{ url: string; received: Received[] }> {
  const received: Received[] = [];
  server = createServer((request, response) => {
    const record: Received = { headers: request.headers, bytes: 0, closed: false };
    const nth = received.push(record);
    request.socket.once('close', () => { record.closed = true; });
    if (!reads) return;
    const pieces: Buffer[] = [];
    request.on('data', (piece: Buffer) => {
      record.bytes += piece.length;
      pieces.push(piece);
    });
    request.on('end', () => {
      record.body = Buffer.concat(pieces);
      answer(request, response, record, nth);
    });
  });
  await new Promise<void>((listening) => server!.listen(0, '127.0.0.1', listening));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, received };
}

afterEach(async () => {
  server?.closeAllConnections();
  await new Promise((closed) => server?.close(closed) ?? closed(undefined));
  server = undefined;
});

const TOKEN = accessToken('first');

/** A transport with no token of its own, so it opens no stream: each upload names its token. */
function contentOf(url: string, config: { timeout?: number; tokenRefresher?: () => Promise<string | null> } = {}) {
  const transport = new HttpTransport({ baseUrl: baseUrl(url), ...config });
  const errors: SemiontError[] = [];
  transport.errors$.subscribe((error) => errors.push(error));
  return { content: new HttpContentTransport(transport), errors };
}

const upload = (file: Buffer) => ({ name: 'Every byte', file, format: 'image/png' as const, storageUri: 'file://uploads/every-byte.png', language: 'en' });

/** `size` bytes that are not all alike. */
const bytes = (size: number): Buffer => Buffer.from(Uint8Array.from({ length: size }, (_, i) => i % 251));

interface Report {
  bytesUploaded: number;
  totalBytes: number;
}

const until = async (what: string, met: () => boolean): Promise<void> => {
  for (let waited = 0; !met(); waited += 5) {
    if (waited > 5000) throw new Error(`waited 5 s for ${what}`);
    await new Promise((tick) => setTimeout(tick, 5));
  }
};

const pause = (ms: number): Promise<void> => new Promise((over) => setTimeout(over, ms));

describe('an upload outside a browser', () => {
  test('reports its progress a piece at a time: one total, never less than it last said, all of it by the end', async () => {
    const { url, received } = await gateway(accepts);
    const { content } = contentOf(url);
    const reports: Report[] = [];

    const result = await content.putBinary(upload(bytes(300 * 1024)), { auth: TOKEN, onProgress: (report) => reports.push(report) });

    expect(result).toEqual({ resourceId: 'uploaded' });
    expect(reports.length, 'a 300 KiB upload is more than one piece').toBeGreaterThan(1);
    const total = reports[0]!.totalBytes;
    expect(reports.map((report) => report.totalBytes)).toEqual(reports.map(() => total));
    expect(total, 'the total is the body as it was sent').toBe(received[0]!.bytes);
    expect(received[0]!.headers['content-length']).toBe(String(total));
    reports.reduce((before, report) => {
      expect(report.bytesUploaded).toBeGreaterThan(before);
      return report.bytesUploaded;
    }, 0);
    expect(reports.at(-1)!.bytesUploaded).toBe(total);
  });

  test('what arrives is the form: each field under its name, and the bytes unchanged', async () => {
    const { url, received } = await gateway(accepts);
    const { content } = contentOf(url);
    const file = bytes(300 * 1024);

    await content.putBinary(upload(file), { auth: TOKEN, onProgress: () => {} });

    const [{ headers, body }] = received as [Received];
    expect(headers.authorization).toBe('Bearer first');
    const form = await new Response(new Uint8Array(body!), { headers: { 'content-type': headers['content-type']! } }).formData();
    expect(form.get('name')).toBe('Every byte');
    expect(form.get('format')).toBe('image/png');
    expect(form.get('storageUri')).toBe('file://uploads/every-byte.png');
    expect(form.get('language')).toBe('en');
    const sent = form.get('file') as File;
    expect(sent.type).toBe('image/png');
    expect(Buffer.from(await sent.arrayBuffer()).equals(file)).toBe(true);
  });

  test('reports no more than the connection has taken', async () => {
    // A gateway that accepts the connection and reads nothing. What the
    // connection will take is its buffers, far short of 24 MiB.
    const { url } = await gateway(accepts, false);
    const { content } = contentOf(url);
    const reports: Report[] = [];
    const caller = new AbortController();

    const sending = content.putBinary(upload(bytes(24 * 1024 * 1024)), { auth: TOKEN, onProgress: (report) => reports.push(report), signal: caller.signal });
    const settled = sending.catch((error: unknown) => error);
    await until('the upload to begin', () => reports.length > 0);
    await pause(300);

    expect(reports.at(-1)!.bytesUploaded).toBeLessThan(reports.at(-1)!.totalBytes);
    caller.abort();
    await settled;
  });

  test('cancelled, it closes its connection unanswered, reports nothing more, and is not sent again', async () => {
    // A gateway that takes the whole upload and does not answer.
    const { url, received } = await gateway(() => {});
    const { content, errors } = contentOf(url, { tokenRefresher: async () => 'second' });
    const reports: Report[] = [];
    const caller = new AbortController();

    const sending = content.putBinary(upload(bytes(300 * 1024)), { auth: TOKEN, onProgress: (report) => reports.push(report), signal: caller.signal });
    const settled = sending.catch((error: unknown) => error);
    await until('the upload to arrive', () => received[0]?.body !== undefined);
    const reported = reports.length;
    caller.abort();

    expect(await settled, 'it rejects with its caller\'s reason, as an abandoned request does').toBe(caller.signal.reason);
    await until('the connection to close', () => received[0]!.closed);
    await pause(200);
    expect(received).toHaveLength(1);
    expect(reports).toHaveLength(reported);
    expect(errors, 'a cancellation its caller asked for is not a transport failure').toEqual([]);
  });

  test('cancelled with no progress asked for, it closes its connection all the same', async () => {
    const { url, received } = await gateway(() => {});
    const { content, errors } = contentOf(url);
    const caller = new AbortController();

    const settled = content.putBinary(upload(bytes(1024)), { auth: TOKEN, signal: caller.signal }).catch((error: unknown) => error);
    await until('the upload to arrive', () => received[0]?.body !== undefined);
    caller.abort();

    expect(await settled).toBe(caller.signal.reason);
    await until('the connection to close', () => received[0]!.closed);
    expect(errors).toEqual([]);
  });

  test('cancelled before it begins, it sends nothing and reports nothing', async () => {
    const { url, received } = await gateway(accepts);
    const { content, errors } = contentOf(url);
    const reports: Report[] = [];
    const caller = new AbortController();
    caller.abort();

    const settled = content.putBinary(upload(bytes(300 * 1024)), { auth: TOKEN, onProgress: (report) => reports.push(report), signal: caller.signal }).catch((error: unknown) => error);

    expect(await settled).toBe(caller.signal.reason);
    await pause(100);
    expect(received).toEqual([]);
    expect(reports).toEqual([]);
    expect(errors).toEqual([]);
  });

  for (const [how, options] of [
    ['', {}],
    [', reporting its progress', { onProgress: () => {} }],
  ] as const) {
    test(`has no deadline${how}: it outlasts the deadline every other request has`, async () => {
      const { url } = await gateway((request, response, received, nth) => {
        setTimeout(() => accepts(request, response, received, nth), 500);
      });
      const { content, errors } = contentOf(url, { timeout: 150 });

      await expect(content.putBinary(upload(bytes(1024)), { auth: TOKEN, ...options })).resolves.toEqual({ resourceId: 'uploaded' });
      expect(errors).toEqual([]);
    });
  }

  test('refused 401 and sent again with a renewed token, it arrives whole and never reports less than it last said', async () => {
    const { url, received } = await gateway((request, response, record, nth) => {
      if (nth === 1) {
        response.writeHead(401, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'The token has expired' }));
        return;
      }
      accepts(request, response, record, nth);
    });
    const { content } = contentOf(url, { tokenRefresher: async () => 'second' });
    const reports: Report[] = [];
    const file = bytes(300 * 1024);

    await expect(content.putBinary(upload(file), { auth: TOKEN, onProgress: (report) => reports.push(report) })).resolves.toEqual({ resourceId: 'uploaded' });

    expect(received.map((record) => record.headers.authorization)).toEqual(['Bearer first', 'Bearer second']);
    expect(received[1]!.body!.equals(received[0]!.body!), 'the second sending is the first, byte for byte').toBe(true);
    reports.reduce((before, report) => {
      expect(report.bytesUploaded).toBeGreaterThanOrEqual(before);
      return report.bytesUploaded;
    }, 0);
    expect(reports.at(-1)!.bytesUploaded).toBe(reports.at(-1)!.totalBytes);
  });
});
