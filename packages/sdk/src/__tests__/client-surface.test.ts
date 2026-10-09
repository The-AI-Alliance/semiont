/**
 * The client's surface against specs/src/client/surface.json: every method
 * the table lists is called as each of its cases states, and what the call
 * did first is held to the row. Every SDK runs the same table, so two SDKs
 * given the same call send the same thing.
 *
 * `CALLS` is typed by the namespace interfaces, so a method added to one
 * with no entry here does not compile, and neither does an entry for a
 * method that is gone. The test then holds `CALLS` and the table to each
 * other: a row with no call fails, and so does a call with no row.
 */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { Observable } from 'rxjs';
import {
  annotationId,
  jobId,
  resourceId,
  type AnnotationId,
  type BodyOperation,
  type EventMap,
  type GatheredContext,
  type GenerationJobParams,
  type IContentTransport,
  type IGatewayOperations,
  type MarkJobParams,
  type Motivation,
  type PutBinaryRequest,
  type ResourceId,
  type TagSchema,
  type components,
} from '@semiont/core';
import { CacheObservable, DelegationObservable, StreamObservable, UploadObservable } from '../awaitable';
import { ClaimsObservable, type ClaimOptions } from '../claims';
import type { SemiontClient } from '../client';
import { createTestClient } from '../testing';
import type {
  AuthNamespace,
  BeckonNamespace,
  BindNamespace,
  BrowseNamespace,
  CreateAnnotationInput,
  CreateFromTokenOptions,
  FrameNamespace,
  GatherNamespace,
  JobNamespace,
  MarkNamespace,
  MatchNamespace,
  SystemNamespace,
  YieldNamespace,
} from '../namespaces/types';

/** The SDK this runner is, as the table's `absent` names it. */
const SDK = 'typescript';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Args = { [key: string]: Json };

interface Step {
  request?: string;
  emit?: string;
  local?: string;
  content?: string;
  gateway?: string;
  observes?: string;
  sends: Json;
}
interface Case {
  why?: string;
  args: Args;
  sends: Json;
  correlationId?: string;
  answers?: Json;
  then?: Step[];
}
interface Row {
  method: string;
  shape: 'promise' | 'stream' | 'delegation' | 'upload' | 'cache' | 'signal' | 'count' | 'events' | 'claims';
  via: Omit<Step, 'sends'>;
  absent?: Record<string, string>;
  cases: Case[];
}
interface Table {
  fixtures: Record<string, Json>;
  namespaces: Array<{ namespace: string; methods: Row[] }>;
}

const TABLE: Table = JSON.parse(
  readFileSync(new URL('../../../../specs/src/client/surface.json', import.meta.url), 'utf8'),
);

/** `value` with each `{"$fixture": name}` replaced by the table's fixture. */
function resolved(value: Json): Json {
  if (Array.isArray(value)) return value.map(resolved);
  if (value === null || typeof value !== 'object') return value;
  const keys = Object.keys(value);
  if (keys.length === 1 && keys[0] === '$fixture') {
    const fixture = TABLE.fixtures[String(value['$fixture'])];
    if (fixture === undefined) throw new Error(`the table has no fixture ${String(value['$fixture'])}`);
    return fixture;
  }
  return Object.fromEntries(keys.map((key) => [key, resolved(value[key] as Json)]));
}

/** A value as it goes over a wire: what is undefined is not there, and a payload of nothing is the empty object. */
const wired = (value: unknown): Json => JSON.parse(JSON.stringify(value ?? {}));

// ── The calls ───────────────────────────────────────────────────────────

interface Namespaces {
  frame: FrameNamespace;
  browse: BrowseNamespace;
  mark: MarkNamespace;
  bind: BindNamespace;
  gather: GatherNamespace;
  match: MatchNamespace;
  yield: YieldNamespace;
  beckon: BeckonNamespace;
  job: JobNamespace;
  auth: AuthNamespace;
  system: SystemNamespace;
}

/** A member's name as the table has it: an `events` row is a property named `<method>$`. */
type Listed<K> = K extends `${infer Stem}$` ? Stem : K;
type Call = (client: SemiontClient, args: Args) => unknown;
type Calls = { [N in keyof Namespaces]: { [M in keyof Namespaces[N] as Listed<M & string>]: Call } };

const rid = (args: Args): ResourceId => resourceId(String(args['resourceId']));
const aid = (args: Args): AnnotationId => annotationId(String(args['annotationId']));
const optional = <T>(value: Json | undefined): T | undefined => (value === undefined ? undefined : (value as T));
const gatewayOf = <T>(namespace: T | undefined): T => {
  if (!namespace) throw new Error('a client with a gateway has auth and system');
  return namespace;
};

const CALLS: Calls = {
  frame: {
    addEntityType: (c, a) => c.frame.addEntityType(String(a['type'])),
    addEntityTypes: (c, a) => c.frame.addEntityTypes(a['types'] as string[]),
    addTagSchema: (c, a) => c.frame.addTagSchema(a['schema'] as TagSchema),
  },
  browse: {
    resource: (c, a) => c.browse.resource(rid(a)),
    resources: (c, a) => c.browse.resources(optional(a['filters'])),
    annotations: (c, a) => c.browse.annotations(rid(a)),
    annotation: (c, a) => c.browse.annotation(rid(a), aid(a)),
    entityTypes: (c) => c.browse.entityTypes(),
    tagSchemas: (c) => c.browse.tagSchemas(),
    agents: (c) => c.browse.agents(),
    events: (c, a) => c.browse.events(rid(a)),
    resourceContent: (c, a) => c.browse.resourceContent(rid(a)),
    resourceGraph: (c, a) => c.browse.resourceGraph(rid(a)),
    resourceAnchoredText: (c, a) => c.browse.resourceAnchoredText(rid(a)),
    resourceRepresentation: (c, a) => c.browse.resourceRepresentation(rid(a)),
    resourceRepresentationStream: (c, a) => c.browse.resourceRepresentationStream(rid(a)),
    resourceEvents: (c, a) => c.browse.resourceEvents(rid(a)),
    annotationHistory: (c, a) => c.browse.annotationHistory(rid(a), aid(a)),
    files: (c, a) => c.browse.files(optional(a['dirPath']), optional(a['sort'])),
    kb: (c) => c.browse.kb(),
    click: (c, a) => c.browse.click(aid(a)),
    openResource: (c, a) => c.browse.openResource(rid(a)),
    resourceViewed: (c, a) => c.browse.resourceViewed(rid(a)),
  },
  mark: {
    annotation: (c, a) => c.mark.annotation(a['input'] as CreateAnnotationInput),
    delete: (c, a) => c.mark.delete(rid(a), aid(a)),
    archive: (c, a) => c.mark.archive(rid(a)),
    unarchive: (c, a) => c.mark.unarchive(rid(a)),
    updateEntityTypes: (c, a) => c.mark.updateEntityTypes(rid(a), a['current'] as string[], a['updated'] as string[]),
    delegate: (c, a) => c.mark.delegate(rid(a), a['params'] as MarkJobParams),
    request: (c, a) =>
      c.mark.request(
        resourceId(String(a['source'])),
        a['selector'] as components['schemas']['MarkRequestedEvent']['selector'],
        a['motivation'] as Motivation,
      ),
    requestDelegate: (c, a) => c.mark.requestDelegate(a['params'] as MarkJobParams),
    submit: (c, a) => c.mark.submit(a['input'] as components['schemas']['MarkSubmitEvent']),
    cancelPending: (c) => c.mark.cancelPending(),
    dismissProgress: (c) => c.mark.dismissProgress(),
    reportDeleteError: (c, a) => c.mark.reportDeleteError(a['input'] as EventMap['mark:delete-error']),
  },
  bind: {
    body: (c, a) => c.bind.body(rid(a), aid(a), a['operations'] as BodyOperation[]),
    initiate: (c, a) => c.bind.initiate(a['input'] as EventMap['bind:initiate']),
    reportBodyError: (c, a) => c.bind.reportBodyError(a['input'] as EventMap['bind:body-error']),
  },
  gather: {
    annotation: (c, a) => c.gather.annotation(rid(a), aid(a), optional(a['options'])),
    resource: (c, a) => c.gather.resource(rid(a), optional(a['options'])),
    referencedBy: (c, a) => c.gather.referencedBy(rid(a)),
  },
  match: {
    search: (c, a) =>
      c.match.search(
        rid(a),
        annotationId(String(a['referenceId'])),
        a['context'] as unknown as GatheredContext,
        optional(a['options']),
      ),
    requestSearch: (c, a) =>
      c.match.requestSearch(a['input'] as unknown as components['schemas']['MatchSearchRequest'], String(a['correlationId'])),
    resources: (c, a) => c.match.resources(String(a['search']), optional(a['filters'])),
  },
  yield: {
    resource: (c, a) => {
      const data = a['data'] as { name: string; content: string; format: string; storageUri: string };
      return c.yield.resource({ name: data.name, file: Buffer.from(data.content), format: data.format, storageUri: data.storageUri });
    },
    delegate: (c, a) =>
      c.yield.delegate(a['params'] as unknown as GenerationJobParams, a['stallDeadlineMs'] === undefined ? undefined : Number(a['stallDeadlineMs'])),
    cloneToken: (c, a) => c.yield.cloneToken(rid(a)),
    fromToken: (c, a) => c.yield.fromToken(String(a['token'])),
    createFromToken: (c, a) => c.yield.createFromToken(a['options'] as CreateFromTokenOptions),
    clone: (c) => c.yield.clone(),
  },
  beckon: {
    attention: (c, a) => c.beckon.attention(rid(a), aid(a)),
    click: (c, a) => c.beckon.click(aid(a)),
    openResource: (c, a) => c.beckon.openResource(rid(a)),
    sparkleAll: (c, a) => c.beckon.sparkleAll(aid(a)),
    hover: (c, a) => c.beckon.hover(a['annotationId'] === null ? null : aid(a)),
    sparkle: (c, a) => c.beckon.sparkle(aid(a)),
  },
  job: {
    queued: (c) => c.job.queued$,
    progress: (c) => c.job.progress$,
    complete: (c) => c.job.complete$,
    fail: (c) => c.job.fail$,
    status: (c, a) => c.job.status(jobId(String(a['jobId']))),
    pollUntilComplete: (c, a) => c.job.pollUntilComplete(jobId(String(a['jobId'])), { interval: 10, timeout: 50 }),
    cancel: (c, a) => c.job.cancel(jobId(String(a['jobId']))),
    claim: (c, a) => c.job.claim(a['options'] as unknown as ClaimOptions),
  },
  auth: {
    me: (c) => gatewayOf(c.auth).me(),
    mediaToken: (c, a) => gatewayOf(c.auth).mediaToken(rid(a)),
    protectedResourceMetadata: (c) => gatewayOf(c.auth).protectedResourceMetadata(),
  },
  system: {
    healthCheck: (c) => gatewayOf(c.system).healthCheck(),
    status: (c) => gatewayOf(c.system).status(),
  },
};

// ── The world a case runs in ────────────────────────────────────────────

interface Recorded {
  operation: string;
  given: Json;
}

function recordingContent(calls: Recorded[]): IContentTransport {
  const read = (operation: string, id: ResourceId): void => {
    calls.push({ operation, given: { resourceId: id as string } });
  };
  return {
    async putBinary(request: PutBinaryRequest) {
      calls.push({
        operation: 'putBinary',
        given: wired({
          name: request.name,
          content: Buffer.from(request.file as Buffer).toString('utf8'),
          format: request.format,
          storageUri: request.storageUri,
          cloneToken: request.cloneToken,
        }),
      });
      return { resourceId: resourceId('res-new') };
    },
    async getBinary(id) {
      read('getBinary', id);
      return { data: new ArrayBuffer(0), contentType: 'text/plain' };
    },
    async getBinaryStream(id) {
      read('getBinaryStream', id);
      return { stream: new ReadableStream<Uint8Array>(), contentType: 'text/plain' };
    },
    async getResourceGraph(id) {
      read('getResourceGraph', id);
      throw new Error('no description is scripted');
    },
    dispose() {},
  };
}

function recordingGateway(calls: Recorded[]): IGatewayOperations {
  const refused = (operation: string, given: Json = {}) => {
    calls.push({ operation, given });
    return Promise.reject(new Error(`not scripted: ${operation}`));
  };
  return {
    getCurrentUser: () => refused('getCurrentUser'),
    getMediaToken: (id) => refused('getMediaToken', { resourceId: id as string }),
    getProtectedResourceMetadata: () => refused('getProtectedResourceMetadata'),
    healthCheck: () => refused('healthCheck'),
    getStatus: () => refused('getStatus'),
  };
}

function world() {
  const content: Recorded[] = [];
  const gateway: Recorded[] = [];
  const { client, transport } = createTestClient({
    content: recordingContent(content),
    gateway: recordingGateway(gateway),
  });
  const wire = vi.spyOn(transport, 'emit');
  const own = vi.spyOn(client.bus, 'emit');
  return { client, transport, wire, own, content, gateway };
}

/** Start what a call returned, as its shape says a caller would, and hold the shape to the row. */
function started(row: Row, returned: unknown): void {
  switch (row.shape) {
    case 'signal':
      expect(returned).toBeUndefined();
      return;
    case 'promise':
    case 'count':
      expect(returned).toBeInstanceOf(Promise);
      (returned as Promise<unknown>).catch(() => {});
      return;
    case 'cache':
      expect(returned).toBeInstanceOf(CacheObservable);
      (returned as CacheObservable<unknown>).fresh().catch(() => {});
      return;
    case 'stream':
      expect(returned).toBeInstanceOf(StreamObservable);
      (returned as StreamObservable<unknown>).subscribe({ error: () => {} });
      return;
    case 'delegation':
      expect(returned).toBeInstanceOf(DelegationObservable);
      (returned as DelegationObservable).subscribe({ error: () => {} });
      return;
    case 'upload':
      expect(returned).toBeInstanceOf(UploadObservable);
      (returned as UploadObservable).subscribe({ error: () => {} });
      return;
    case 'events':
      expect(returned).toBeInstanceOf(Observable);
      return;
    case 'claims':
      expect(returned).toBeInstanceOf(ClaimsObservable);
      (returned as ClaimsObservable).subscribe({ error: () => {} });
      return;
  }
}

/** One step of a case: what was done, and what it was given. */
async function heldTo(w: ReturnType<typeof world>, at: number, step: Step, sends: Json): Promise<void> {
  const named = step.request ?? step.emit;
  if (named !== undefined) {
    await vi.waitFor(() => expect(w.wire.mock.calls.length).toBeGreaterThan(at));
    const [channel, payload, envelope] = w.wire.mock.calls[at]!;
    expect(channel).toBe(named);
    expect(wired(payload)).toEqual(sends);
    expect(envelope?.scope).toBeUndefined();
    // A request carries a key of the client's making; a frame nobody answers carries none.
    expect(envelope?.correlationId !== undefined).toBe(step.request !== undefined);
    return;
  }
  const calls = step.content !== undefined ? w.content : w.gateway;
  await vi.waitFor(() => expect(calls.length).toBeGreaterThan(0));
  expect(calls[0]).toEqual({ operation: step.content ?? step.gateway, given: sends });
}

function callOf(namespace: string, method: string): Call | undefined {
  const calls: Record<string, Record<string, Call>> = CALLS;
  return calls[namespace]?.[method];
}

describe('the client surface (specs/src/client/surface.json)', () => {
  const listed = TABLE.namespaces.flatMap(({ namespace, methods }) =>
    methods.filter((row) => row.absent?.[SDK] === undefined).map((row) => ({ namespace, row })),
  );

  it('lists the methods this SDK has, and no other', () => {
    const calls: Record<string, Record<string, Call>> = CALLS;
    const called = Object.entries(calls).flatMap(([namespace, methods]) =>
      Object.keys(methods).map((method) => `${namespace}.${method}`),
    );
    expect(called.sort()).toEqual(listed.map(({ namespace, row }) => `${namespace}.${row.method}`).sort());
  });

  for (const { namespace, row } of listed) {
    const [[kind, channel]] = Object.entries(row.via) as [[keyof Step, string]];

    it.each(row.cases.map((c) => [c.why ?? 'as stated', c] as const))(`${namespace}.${row.method}: %s`, async (_why, stated) => {
      const call = callOf(namespace, row.method);
      if (!call) throw new Error(`this SDK's surface test has no call for ${namespace}.${row.method}`);
      const w = world();
      const args = resolved(stated.args) as Args;
      const sends = resolved(stated.sends);
      if ('answers' in stated) {
        w.transport.queueReply(channel as Parameters<typeof w.transport.queueReply>[0], stated.answers === null ? undefined : resolved(stated.answers ?? null));
      }

      if (kind === 'observes') {
        const heard: unknown[] = [];
        const events = call(w.client, args);
        started(row, events);
        (events as Observable<unknown>).subscribe((event) => heard.push(event));
        w.client.bus.emit(channel as keyof EventMap, sends as never);
        expect(heard.map(wired)).toEqual([sends]);
        return;
      }

      started(row, call(w.client, args));

      if (kind === 'local') {
        expect(w.own.mock.calls.length).toBeGreaterThan(0);
        const [published, payload, envelope] = w.own.mock.calls[0]!;
        expect(published).toBe(channel);
        expect(wired(payload)).toEqual(sends);
        expect(envelope?.correlationId).toBe(stated.correlationId);
        await Promise.resolve();
        // A signal never reaches the wire.
        expect(w.wire).not.toHaveBeenCalled();
        return;
      }

      await heldTo(w, 0, { ...row.via, sends }, sends);
      for (const [index, step] of (stated.then ?? []).entries()) {
        await heldTo(w, index + 1, step, resolved(step.sends));
      }
    });
  }
});
