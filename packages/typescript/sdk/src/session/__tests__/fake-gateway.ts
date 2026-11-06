/**
 * A knowledge base's gateway and the issuer it trusts, as the `fetch` a
 * session over HTTP is made with sees them, for tests of what the sessions
 * of `createHttpSessionFactory` read, write and ask. Nothing inside the SDK
 * is stood in for.
 *
 * It says who a token is as the test says; renews a token at the issuer the
 * seeded sessions name (`TEST_TOKEN_ENDPOINT`); holds a stream open for every
 * connect, recording what each connect asked for; and answers a read of a
 * resource with that resource, named as the test says. A reply is said on
 * every stream open when it is made, and again on a connect that names it
 * pending, as a gateway keeps a reply for whoever asked.
 */

import type { components } from '@semiont/core';
import { freshJwt, TEST_TOKEN_ENDPOINT } from './test-storage-helpers';

/** Where the gateway is: a knowledge base's endpoint names it so. */
export const GATEWAY_ENDPOINT = { kind: 'http', host: 'localhost', port: 4000, protocol: 'http' } as const;
const ORIGIN = 'http://localhost:4000';

/** What a stream's connect asks for: the channels and scopes, and where each scope resumes. */
export type StreamConnect = components['schemas']['BusSubscribeRequest'];

export interface FakeGateway {
  readonly fetch: typeof globalThis.fetch;
  /** Every stream connect, in the order they came. */
  readonly connects: readonly StreamConnect[];
  /** End every stream the gateway holds open. */
  close(): void;
}

export interface FakeGatewayOptions {
  /** The gateway's answer to who a token is; a rejection when it cannot be reached. */
  whoIs: () => Promise<Response>;
  /** The name a resource is read with. */
  resourceName: string;
}

/** What a read of a resource is asked with: the part of an emit the gateway answers. */
interface Emitted {
  channel: string;
  payload: { resourceId?: string };
  correlationId?: string;
}

export function fakeGateway({ whoIs, resourceName }: FakeGatewayOptions): FakeGateway {
  const connects: StreamConnect[] = [];
  const open = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const replies = new Map<string, Uint8Array>();
  const encoder = new TextEncoder();

  const stream = (signal: AbortSignal, pending: readonly string[]): Response => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start: (started) => {
        controller = started;
      },
      cancel: () => {
        open.delete(controller);
      },
    });
    open.add(controller);
    for (const correlationId of pending) {
      const reply = replies.get(correlationId);
      if (reply !== undefined) controller.enqueue(reply);
    }
    signal.addEventListener('abort', () => {
      open.delete(controller);
      controller.error(new DOMException('aborted', 'AbortError'));
    }, { once: true });
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  };

  const answer = (sent: Emitted): void => {
    const { resourceId } = sent.payload;
    if (sent.channel !== 'browse:resource-requested' || sent.correlationId === undefined || resourceId === undefined) return;
    const frame = {
      channel: 'browse:resource-result',
      correlationId: sent.correlationId,
      payload: {
        response: {
          resource: { '@context': 'https://schema.org/', '@id': resourceId, name: resourceName, representations: [] },
          lastSequence: 1,
        },
      },
    };
    const reply = encoder.encode(`event: bus-event\ndata: ${JSON.stringify(frame)}\n\n`);
    replies.set(sent.correlationId, reply);
    for (const controller of open) controller.enqueue(reply);
  };

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (request.url === TEST_TOKEN_ENDPOINT) {
      return Response.json({ access_token: freshJwt(), refresh_token: 'renewed' });
    }
    if (!request.url.startsWith(`${ORIGIN}/`)) return new Response(null, { status: 404 });
    const { pathname } = new URL(request.url);
    switch (`${request.method} ${pathname}`) {
      case 'GET /api/users/me':
        return whoIs();
      case 'POST /bus/subscribe': {
        const signal = init?.signal;
        if (!signal) throw new Error('A stream is connected with the signal that ends it');
        const connect = (await request.json()) as StreamConnect;
        connects.push(connect);
        return stream(signal, connect.pendingReplies === undefined ? [] : connect.pendingReplies);
      }
      case 'POST /bus/emit': {
        answer((await request.json()) as Emitted);
        return Response.json({ subscribers: 1 }, { status: 202 });
      }
    }
    return new Response(null, { status: 404 });
  };

  return {
    fetch,
    connects,
    close: () => {
      for (const controller of open) controller.close();
      open.clear();
    },
  };
}
