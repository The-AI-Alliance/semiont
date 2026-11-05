/**
 * How long the gateway waits for the Archivist: the Archivist document's
 * `x-semiont-limits.readSeconds` for each part of an answer, for the answer
 * to begin once its request is sent whole and for each next part, and no
 * bound on a whole answer or on sending a request
 * (protocol/specs/src/archivist/openapi.json, whose description states the
 * rule). `connectSeconds` is not held here: an address that takes no
 * connection cannot be staged on the loopback.
 *
 * Plane-independent, and slow: it waits `readSeconds` out, four waits side by
 * side. The fourth is an upload the Archivist recorded and never answered: its
 * resend, under its key, is answered with the resource it made
 * (protocol/specs/src/paths/resources.json, A key).
 */
import { randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { expect, it } from 'vitest';
import { call, nonConformance } from '../harness/http';
import { archivistSpec } from '../harness/spec';
import { eachPlane } from '../harness/world';

const READ_MS = archivistSpec().documentLimit('readSeconds') * 1000;

/** How long the slow upload takes to send: a wait counted from its first byte would end this much before one counted from its last. */
const SENDING_MS = 10_000;

const BYTES = Buffer.from(Array.from({ length: 1024 }, (_, i) => i % 256));

/** That `elapsed` waited the wait out: no sooner than it, less a quarter second for the trip, and not past 1.3 times it. */
function waitedOut(what: string, elapsed: number): void {
  expect(elapsed, `${what}: ${elapsed} ms`).toBeGreaterThanOrEqual(READ_MS - 250);
  expect(elapsed, `${what}: ${elapsed} ms`).toBeLessThan(READ_MS * 1.3);
}

/**
 * An upload whose file goes a piece at a time over SENDING_MS: its status,
 * when its last byte was written, and when its answer came.
 */
function slowUpload(origin: string, token: string, storageUri: string): Promise<{ status: number; lastByte: number; answered: number }> {
  const boundary = `conformance-${randomUUID()}`;
  const field = (name: string, value: string) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
  const head = Buffer.from(
    field('name', 'Slow') +
      field('format', 'text/plain') +
      field('storageUri', storageUri) +
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="slow.txt"\r\nContent-Type: text/plain\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const pieces = 10;
  const piece = Buffer.from('x'.repeat(100));
  return new Promise((resolve, reject) => {
    let lastByte = 0;
    const req = request(
      new URL('/resources', origin),
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'idempotency-key': randomUUID(),
          'content-type': `multipart/form-data; boundary=${boundary}`,
          'content-length': String(head.length + pieces * piece.length + tail.length),
        },
      },
      (res) => {
        const answered = Date.now();
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode ?? 0, lastByte, answered }));
      },
    );
    req.on('error', reject);
    req.write(head);
    let sent = 0;
    const timer = setInterval(() => {
      req.write(piece);
      sent += 1;
      if (sent === pieces) {
        clearInterval(timer);
        req.end(tail);
        lastByte = Date.now();
      }
    }, SENDING_MS / pieces);
  });
}

eachPlane('an Archivist that stops answering', (world) => {
  it('is waited for readSeconds for each part of an answer, counted from a request\'s last byte; an upload it recorded and never answered is answered on its resend under its key', async () => {
    const token = await world().person('waiting');
    const stored = (id: string) => {
      world().archivist.resources.set(id, { storageUri: `file://${id}`, mediaType: 'text/plain' });
      world().archivist.content.set(`file://${id}`, BYTES);
    };

    const neverAnswered = async () => {
      const id = `res-${randomUUID()}`;
      stored(id);
      world().archivist.mode.unanswered.add(id);
      const started = Date.now();
      const reply = await call(world().origin, 'GET', `/resources/${id}`, { token });
      waitedOut('a read never answered', Date.now() - started);
      expect(reply.status).toBe(503);
      expect(nonConformance('get', '/resources/{id}', reply)).toEqual([]);
      // A read whose wait ran out is not sent again.
      expect(world().archivist.calls.filter((c) => c.path === `/resources/${id}/content`)).toHaveLength(1);
    };

    const answeredInPart = async () => {
      const id = `res-${randomUUID()}`;
      stored(id);
      world().archivist.mode.answeredInPart.add(id);
      const res = await fetch(`${world().origin}/resources/${id}`, { headers: { authorization: `Bearer ${token}` } });
      const headed = Date.now();
      expect(res.status).toBe(200);
      const body = await res.arrayBuffer().then(
        () => 'whole',
        () => 'cut short',
      );
      waitedOut('an answer that stopped part way', Date.now() - headed);
      expect(body).toBe('cut short');
    };

    const uploadNeverAnswered = async () => {
      const storageUri = `file://uploads/${randomUUID()}`;
      world().archivist.mode.unanswered.add(storageUri);
      const { status, lastByte, answered } = await slowUpload(world().origin, token, storageUri);
      expect(status).toBe(503);
      waitedOut('an upload never answered, from its last byte', answered - lastByte);
      expect(world().archivist.uploads.some((u) => u.fields['storageUri'] === storageUri)).toBe(false);
    };

    const recordedNeverAnswered = async () => {
      const key = randomUUID();
      const storageUri = `file://uploads/${randomUUID()}`;
      const form = () => {
        const body = new FormData();
        for (const [k, v] of Object.entries({ name: 'Recorded', format: 'text/plain', storageUri })) body.set(k, v);
        body.set('file', new Blob([new Uint8Array(BYTES)], { type: 'text/plain' }), 'recorded.txt');
        return body;
      };
      const made = () => world().archivist.uploads.filter((u) => u.fields['storageUri'] === storageUri);
      world().archivist.mode.recordsUnanswered.add(storageUri);

      const lost = await world().upload(token, form(), key);
      expect(lost.status, lost.text).toBe(503);
      expect(nonConformance('post', '/resources', lost)).toEqual([]);
      expect(made()).toHaveLength(1);

      const resent = await world().upload(token, form(), key);
      expect(resent.status, resent.text).toBe(202);
      expect(nonConformance('post', '/resources', resent)).toEqual([]);
      expect(resent.json).toEqual({ resourceId: made()[0]!.resourceId });
      expect(made()).toHaveLength(1);
    };

    await Promise.all([neverAnswered(), answeredInPart(), uploadNeverAnswered(), recordedNeverAnswered()]);
  }, READ_MS * 2 + SENDING_MS + 30_000);
}, {}, ['in-process']);
