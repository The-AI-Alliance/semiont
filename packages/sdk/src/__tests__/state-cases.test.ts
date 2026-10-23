/**
 * The state units against specs/src/client/state-units.json.
 *
 * Each case of a unit this SDK has is run as the table states it: its units
 * are built over a scripted transport, driven step by step, and held to what
 * the case says they hold and said. A unit that the names table
 * (specs/src/client/surface.json, `stateUnits`) says this SDK lacks has its
 * cases left unrun, as the surface test leaves a row's `absent` SDK: they run
 * once the unit lands and its `absent` goes. What the table may say is held by
 * scripts/lint/check-state-unit-cases.mjs; what a case cannot say, the axioms,
 * each unit's own test holds.
 */

import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Subject, type Observable } from 'rxjs';
import {
  SemiontError,
  annotationId,
  resourceId,
  type AnnotationId,
  type BusOperationKey,
  type EventMap,
  type GenerationJobParams,
  type MarkJobParams,
  type StateUnit,
  type Watched,
} from '@semiont/core';
import type { SemiontClient } from '../client';
import { createTestClient, refuseUnscriptedOperation, type FaultAction, type FaultyTransport, type FaultyTransportConfig } from '../testing';
import { createBeckonStateUnit, createHoverDwell, type BeckonStateUnit, type HoverDwell } from '../state/flows/beckon-state-unit';
import { createGatherStateUnit, type GatherStateUnit } from '../state/flows/gather-state-unit';
import { createMarkStateUnit, type MarkStateUnit } from '../state/flows/mark-state-unit';
import { createMatchStateUnit, type MatchStateUnit } from '../state/flows/match-state-unit';
import { createYieldStateUnit, type YieldStateUnit } from '../state/flows/yield-state-unit';
import { createSearchPipeline, type SearchPipeline } from '../state/lib/search-pipeline';
import {
  createSessionSignals,
  type KbIdentityConflict,
  type SessionEndReason,
  type SessionSignals,
} from '../session/session-signals';

/** The SDK this runner is, as the names table's `absent` names it. */
const SDK = 'typescript';

/** How many rounds a settle lets pass: enough for what any case sets going to run to its end, the clock held still. */
const SETTLE_TURNS = 200;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

interface Case {
  unit: string;
  case: string;
  transport: JsonObject;
  made: Record<string, JsonObject>;
  listen?: string[];
  steps: Json[];
}

const read = (path: string): unknown => JSON.parse(readFileSync(new URL(`../../../../specs/src/${path}`, import.meta.url), 'utf8'));

const TABLE = read('client/state-units.json') as { fixtures: Record<string, Json>; cases: Case[] };
const NAMES = read('client/surface.json') as { stateUnits: Array<{ unit: string; absent?: Record<string, string> }> };
const TIMING = new Map(
  (read('client/timing.json') as { timing: Array<{ name: string; value: number }> }).timing.map(({ name, value }) => [name, value]),
);

// ── Reading the table ───────────────────────────────────────────────────

function text(value: Json | undefined, what: string): string {
  if (typeof value !== 'string') throw new Error(`${what} is not a string: ${JSON.stringify(value)}`);
  return value;
}

function object(value: Json | undefined, what: string): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${what} is not an object: ${JSON.stringify(value)}`);
  return value;
}

function count(value: Json | undefined, what: string): number {
  if (typeof value !== 'number') throw new Error(`${what} is not a number: ${JSON.stringify(value)}`);
  return value;
}

function strings(value: Json | undefined, what: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${what} is not a list: ${JSON.stringify(value)}`);
  return value.map((item) => text(item, what));
}

/** `value` with each `{"$fixture": name}` replaced by the table's fixture. */
function resolved(value: Json): Json {
  if (Array.isArray(value)) return value.map(resolved);
  if (value === null || typeof value !== 'object') return value;
  const keys = Object.keys(value);
  if (keys.length === 1 && keys[0] === '$fixture') {
    const name = text(value['$fixture'], "a fixture's name");
    const fixture = TABLE.fixtures[name];
    if (fixture === undefined) throw new Error(`the table has no fixture ${name}`);
    return resolved(fixture);
  }
  return Object.fromEntries(keys.map((key) => [key, resolved(value[key] as Json)]));
}

/** A duration as the table states it, in milliseconds: a number, or a timing of specs/src/client/timing.json scaled and moved. */
function durationMs(value: Json | undefined): number {
  if (typeof value === 'number') return value;
  const stated = object(value, 'a duration');
  const name = text(stated['timing'], 'a timing');
  const base = TIMING.get(name);
  if (base === undefined) throw new Error(`${name} is no timing of specs/src/client/timing.json`);
  const times = stated['times'] === undefined ? 1 : count(stated['times'], 'times');
  const plus = stated['plusMs'] === undefined ? 0 : count(stated['plusMs'], 'plusMs');
  return base * times + plus;
}

// ── What a case searches with ───────────────────────────────────────────

/** What a case's search pipeline searches with: it records each query it is asked, and gives each the answers a step gives it. */
class Searches {
  readonly asked: Array<{ query: string; answers: Subject<string[] | undefined> }> = [];

  search(query: string): Observable<string[] | undefined> {
    const answers = new Subject<string[] | undefined>();
    this.asked.push({ query, answers });
    return answers;
  }

  /** Answer the `nth` query: its results, or none for one still on its way. One that was abandoned has nobody to give it to. */
  answer(nth: number, results: string[] | undefined): void {
    const asked = this.asked[nth];
    if (asked === undefined) throw new Error(`query #${nth} was not asked`);
    asked.answers.next(results);
  }
}

// ── The units, as a case drives and reads them ──────────────────────────

/** What a case calls a method with: its arguments by the method's parameter names. */
type Args = JsonObject;

/** A unit's methods by name, each as a case calls it: every public method but `dispose`, which is a step of its own. */
type Methods<U> = {
  [M in keyof U as U[M] extends (...args: never[]) => unknown ? (M extends 'dispose' ? never : M) : never]: (args: Args) => void;
};

/** A unit's states by the table's name for each: `<member>$` here. */
type States<U> = { [M in keyof U as M extends `${infer Stem}$` ? Stem : never]: Watched<unknown> };

/** A unit made for a case: the unit, and its methods and states by the names the table uses. */
interface Played {
  unit: StateUnit;
  methods: Readonly<Record<string, (args: Args) => void>>;
  states: Readonly<Record<string, Watched<unknown>>>;
}

type Make = (client: SemiontClient, searches: Searches, made: JsonObject) => Played;

const annotationOf = (args: Args): AnnotationId => annotationId(text(args['annotationId'], 'annotationId'));

/**
 * How this SDK makes each unit it has, from the client and what the case
 * makes it from. Each unit's methods and states are listed in full: the
 * compiler holds each list to the unit's own interface.
 */
const MAKERS: Record<string, Make> = {
  match: (client) => {
    const unit: MatchStateUnit = createMatchStateUnit(client);
    return { unit, methods: {} satisfies Methods<MatchStateUnit>, states: {} satisfies States<MatchStateUnit> };
  },
  beckon: (client) => {
    const unit: BeckonStateUnit = createBeckonStateUnit(client);
    return {
      unit,
      methods: { focus: (args) => unit.focus(annotationOf(args)) } satisfies Methods<BeckonStateUnit>,
      states: { hoveredAnnotationId: unit.hoveredAnnotationId$ } satisfies States<BeckonStateUnit>,
    };
  },
  hoverDwell: (client, _searches, made) => {
    const unit: HoverDwell = createHoverDwell((hovered) => client.beckon.hover(hovered), durationMs(made['delayMs']));
    return {
      unit,
      methods: { enter: (args) => unit.enter(annotationOf(args)), leave: () => unit.leave() } satisfies Methods<HoverDwell>,
      states: {} satisfies States<HoverDwell>,
    };
  },
  gather: (client, _searches, made) => {
    const unit: GatherStateUnit = createGatherStateUnit(client, resourceId(text(made['resourceId'], 'a resource')));
    return {
      unit,
      methods: {
        gatherAnnotation: (args) =>
          unit.gatherAnnotation(
            annotationOf(args),
            args['contextWindow'] === undefined ? undefined : { contextWindow: count(args['contextWindow'], 'contextWindow') },
          ),
        gatherResource: (args) => unit.gatherResource(resourceId(text(args['resourceId'], 'resourceId'))),
      } satisfies Methods<GatherStateUnit>,
      states: {
        context: unit.context$,
        loading: unit.loading$,
        error: unit.error$,
        annotationId: unit.annotationId$,
        resourceContext: unit.resourceContext$,
        resourceLoading: unit.resourceLoading$,
        resourceError: unit.resourceError$,
      } satisfies States<GatherStateUnit>,
    };
  },
  search: (_client, searches, made) => {
    const unit: SearchPipeline<string> = createSearchPipeline((query) => searches.search(query), {
      ...(made['debounceMs'] !== undefined ? { debounceMs: durationMs(made['debounceMs']) } : {}),
      ...(made['initialQuery'] !== undefined ? { initialQuery: text(made['initialQuery'], 'an initial query') } : {}),
    });
    return {
      unit,
      methods: { setQuery: (args) => unit.setQuery(text(args['value'], 'value')) } satisfies Methods<SearchPipeline<string>>,
      states: { query: unit.query$, state: unit.state$ } satisfies States<SearchPipeline<string>>,
    };
  },
  yield: (client, _searches, made) => {
    const unit: YieldStateUnit = createYieldStateUnit(client, text(made['locale'], 'a locale'));
    return {
      unit,
      methods: {
        // The generation's parameters are the wire's, as the case writes them.
        generate: (args) =>
          unit.generate(
            object(args['params'], 'params') as unknown as GenerationJobParams,
            args['stallDeadlineMs'] === undefined ? undefined : count(args['stallDeadlineMs'], 'stallDeadlineMs'),
          ),
        dismissProgress: () => unit.dismissProgress(),
      } satisfies Methods<YieldStateUnit>,
      states: {
        isGenerating: unit.isGenerating$,
        progress: unit.progress$,
        outcome: unit.outcome$,
        failure: unit.failure$,
        jobId: unit.jobId$,
      } satisfies States<YieldStateUnit>,
    };
  },
  mark: (client, _searches, made) => {
    const unit: MarkStateUnit = createMarkStateUnit(client, resourceId(text(made['resourceId'], 'a resource')));
    return {
      unit,
      methods: {
        // The job's parameters are the wire's, as the case writes them.
        requestDelegate: (args) => unit.requestDelegate(object(args['params'], 'params') as unknown as MarkJobParams),
        cancelPending: () => unit.cancelPending(),
        dismissProgress: () => unit.dismissProgress(),
      } satisfies Methods<MarkStateUnit>,
      states: {
        pendingAnnotation: unit.pendingAnnotation$,
        delegatingMotivation: unit.delegatingMotivation$,
        progress: unit.progress$,
        progressMotivation: unit.progressMotivation$,
        failure: unit.failure$,
        jobId: unit.jobId$,
      } satisfies States<MarkStateUnit>,
    };
  },
  sessionSignals: () => {
    const unit: SessionSignals = createSessionSignals();
    return {
      unit,
      methods: {
        notifySessionEnded: (args) => unit.notifySessionEnded(text(args['reason'], 'reason') as SessionEndReason),
        notifyPermissionDenied: (args) =>
          unit.notifyPermissionDenied(args['detail'] === null ? null : text(args['detail'], 'detail')),
        notifyKbIdentityConflict: (args) => {
          const conflict = object(args['conflict'], 'conflict');
          const stated: KbIdentityConflict = {
            expectedDid: text(conflict['expectedDid'], 'expectedDid'),
            observedDid: text(conflict['observedDid'], 'observedDid'),
          };
          unit.notifyKbIdentityConflict(stated);
        },
        acknowledgeSessionEnded: () => unit.acknowledgeSessionEnded(),
        acknowledgePermissionDenied: () => unit.acknowledgePermissionDenied(),
        acknowledgeKbIdentityConflict: () => unit.acknowledgeKbIdentityConflict(),
      } satisfies Methods<SessionSignals>,
      states: {
        sessionEnded: unit.sessionEnded$,
        permissionDenied: unit.permissionDenied$,
        kbIdentityConflict: unit.kbIdentityConflict$,
      } satisfies States<SessionSignals>,
    };
  },
};

const HAS = new Set(NAMES.stateUnits.filter((row) => row.absent?.[SDK] === undefined).map((row) => row.unit));
const RUN = TABLE.cases.filter((stated) => HAS.has(stated.unit));

// ── The transport ───────────────────────────────────────────────────────

const JOB_RUNNING = {
  jobId: 'job-1',
  type: 'mark',
  status: 'running',
  userId: 'did:web:example.org:users:alice',
  created: '2026-10-01T00:00:00.000Z',
};

function jobs(operation: BusOperationKey): unknown {
  switch (operation) {
    case 'job:create':
      return { jobId: 'job-1' };
    case 'job:status-requested':
      return JOB_RUNNING;
    default:
      return refuseUnscriptedOperation(operation);
  }
}

/** The transport a case states. Its stream carries what a client's does: the replies and the broadcasts, never the requests. */
function transportOf(stated: JsonObject): FaultyTransportConfig {
  const answers = text(stated['answers'], 'transport.answers');
  const delay = stated['delayMs'];
  const schedule: FaultAction[] = delay === undefined ? [] : [{ kind: 'delay', ms: durationMs(delay) }];
  switch (answers) {
    case 'never':
      if (delay !== undefined) throw new Error('a transport that never answers holds no reply');
      // The reply this answers with is dropped on its way, and a step answers instead.
      return { schedule: [{ kind: 'drop-reply' }], makeResponse: () => undefined };
    case 'refuses':
      return { schedule };
    case 'jobs':
      return { schedule, makeResponse: jobs };
    default:
      throw new Error(`no transport answers ${answers}`);
  }
}

// ── What a unit holds, as the wire writes it ────────────────────────────

/** What a state holds, as the wire writes it. An error is its code and its message. */
function wire(held: unknown): Json {
  if (held instanceof SemiontError) return { code: held.code, message: held.message };
  if (held instanceof Error) return { message: held.message };
  if (held === undefined) throw new Error('it holds undefined, where none is null');
  return JSON.parse(JSON.stringify(held)) as Json;
}

/** Whether `actual` is what `expected` states: exactly, but where `$has` asks only for some members. */
function matches(expected: Json, actual: Json): boolean {
  if (expected !== null && typeof expected === 'object' && !Array.isArray(expected)) {
    const keys = Object.keys(expected);
    if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) return false;
    if (keys.length === 1 && keys[0] === '$has') {
      const has = object(expected['$has'], '$has');
      return Object.keys(has).every((key) => key in actual && matches(has[key] as Json, actual[key] as Json));
    }
    const theirs = Object.keys(actual);
    return (
      keys.length === theirs.length &&
      keys.every((key) => key in actual && matches(expected[key] as Json, actual[key] as Json))
    );
  }
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && expected.length === actual.length && expected.every((one, at) => matches(one, actual[at] as Json));
  }
  return expected === actual;
}

/** Whether a state holds what `expected` states. An error is compared on what the case states of it. */
function holds(expected: Json, held: unknown): boolean {
  if (held instanceof Error) {
    const stated = object(expected, `the case's statement of an error (${held.message})`);
    const written = object(wire(held), 'an error');
    return Object.keys(stated).every((key) => written[key] === stated[key]);
  }
  return matches(resolved(expected), wire(held));
}

function check(condition: boolean, message: () => string): asserts condition {
  if (!condition) throw new Error(message());
}

/** Whether a reader of `state` ends, as a state's readers do once its unit is disposed. */
function hasEnded(state: Watched<unknown>): boolean {
  let ended = false;
  state.subscribe({ complete: () => { ended = true; } }).unsubscribe();
  return ended;
}

// ── A case, played ──────────────────────────────────────────────────────

/** Let what is ready run, and what that makes ready, without moving the clock. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < SETTLE_TURNS; turn++) await vi.advanceTimersByTimeAsync(0);
}

interface Heard {
  channel: string;
  payload: unknown;
  correlationId: string | undefined;
}

/** The correlation id the `nth` request sent on a channel carried. */
function requestId(transport: FaultyTransport, named: JsonObject): string | undefined {
  const channel = text(named['sent'], "a request's channel");
  const nth = count(named['nth'], 'nth');
  const sent = transport.requestLog.filter((entry) => entry.channel === channel);
  const entry = sent[nth];
  check(entry !== undefined, () => `request #${nth} on ${channel} was not sent`);
  return entry.correlationId;
}

/** An envelope carrying `correlationId`, or none when the step states none. */
const envelopeOf = (correlation: Json | undefined): { correlationId: string } | undefined =>
  correlation === undefined ? undefined : { correlationId: text(correlation, 'correlationId') };

interface World {
  client: SemiontClient;
  transport: FaultyTransport;
  searches: Searches;
  units: Record<string, Played>;
  heard: Heard[];
}

function unitOf(world: World, name: Json | undefined): Played {
  const named = text(name, 'a unit');
  const unit = world.units[named];
  if (unit === undefined) throw new Error(`the case made no unit ${named}`);
  return unit;
}

function stateOf(world: World, name: string, member: string): Watched<unknown> {
  const state = unitOf(world, name).states[member];
  if (state === undefined) throw new Error(`${name} has no state ${member}`);
  return state;
}

/** Perform one step. Returns how much of what was heard has been checked. */
async function perform(step: Json, world: World, told: number): Promise<number> {
  const { client, transport, searches, heard } = world;
  if (step === 'settle') {
    await settle();
    return told;
  }
  const stated = object(step, 'a step');
  if ('say' in stated) {
    client.bus.emit(
      text(stated['say'], 'a channel') as keyof EventMap,
      resolved(object(stated['payload'], 'a payload')) as unknown as EventMap[keyof EventMap],
      envelopeOf(stated['correlationId']),
    );
  } else if ('deliver' in stated) {
    // The test transport hands what it is sent on a channel that is no request to the client's stream, as the wire does another participant's.
    void transport.emit(
      text(stated['deliver'], 'a channel') as keyof EventMap,
      resolved(object(stated['payload'], 'a payload')) as unknown as EventMap[keyof EventMap],
      envelopeOf(stated['correlationId']),
    );
  } else if ('answer' in stated) {
    const asked = requestId(transport, { sent: stated['answer'] ?? null, nth: stated['nth'] ?? null });
    void transport.emit(
      text(stated['reply'], "a reply's channel") as keyof EventMap,
      resolved(object(stated['payload'], 'a payload')) as unknown as EventMap[keyof EventMap],
      asked === undefined ? undefined : { correlationId: asked },
    );
  } else if ('queueReply' in stated) {
    transport.queueReply(text(stated['queueReply'], 'an operation') as BusOperationKey, resolved(stated['response'] ?? null));
  } else if ('invoke' in stated) {
    const name = text(stated['invoke'], 'a method');
    const method = unitOf(world, stated['of']).methods[name];
    if (method === undefined) throw new Error(`${text(stated['of'], 'a unit')} has no method ${name}`);
    method(object(resolved(stated['args'] ?? null), 'args'));
  } else if ('pass' in stated) {
    // What is ready runs at the time it became ready, before the clock moves; what falls due runs to its end.
    await settle();
    await vi.advanceTimersByTimeAsync(durationMs(stated['pass']));
    await settle();
  } else if ('dispose' in stated) {
    unitOf(world, stated['dispose']).unit.dispose();
  } else if ('answerSearch' in stated) {
    const results = stated['results'];
    searches.answer(count(stated['answerSearch'], 'answerSearch'), results === null ? undefined : strings(results, "an answer's results"));
  } else if ('searched' in stated) {
    const queries = searches.asked.map((asked) => asked.query);
    const wanted = strings(stated['searched'], 'searched');
    check(matches(wanted, queries), () => `the search was asked ${JSON.stringify(queries)}`);
  } else if ('expect' in stated) {
    for (const [name, members] of Object.entries(object(stated['expect'], 'expect'))) {
      for (const [member, value] of Object.entries(object(members, `${name}'s members`))) {
        const held = stateOf(world, name, member).getValue();
        check(holds(value, held), () => `${name}.${member} holds ${JSON.stringify(held instanceof Error ? wire(held) : held)}, not ${JSON.stringify(value)}`);
      }
    }
  } else if ('sent' in stated) {
    const channel = text(stated['sent'], "a request's channel");
    const sent = transport.requestLog.filter((entry) => entry.channel === channel).map((entry) => wire(entry.payload));
    if ('count' in stated) {
      check(sent.length === count(stated['count'], 'count'), () => `${sent.length} requests were sent on ${channel}, not ${JSON.stringify(stated['count'])}`);
    } else {
      check(matches(resolved(stated['payloads'] ?? null), sent), () => `sent on ${channel}: ${JSON.stringify(sent)}`);
    }
  } else if ('nothingSent' in stated) {
    check(transport.requestLog.length === 0, () => `requests were sent: ${JSON.stringify(transport.requestLog.map((entry) => entry.channel))}`);
  } else if ('heard' in stated) {
    await settle();
    const frames = heard.slice(told);
    const got = frames.map((frame) => ({ channel: frame.channel, payload: wire(frame.payload), correlationId: frame.correlationId ?? null }));
    const wanted = stated['heard'];
    check(Array.isArray(wanted) && wanted.length === frames.length, () => `heard ${JSON.stringify(got)}`);
    frames.forEach((frame, at) => {
      const one = object(wanted[at], 'a heard entry');
      const correlation = one['correlationId'];
      const expectedId =
        correlation === undefined ? undefined
        : correlation !== null && typeof correlation === 'object' && !Array.isArray(correlation) ? requestId(transport, correlation)
        : text(correlation, 'correlationId');
      check(frame.channel === one['channel'], () => `heard ${JSON.stringify(got)}`);
      check(matches(resolved(one['payload'] ?? null), wire(frame.payload)), () => `heard ${JSON.stringify(got)}`);
      check(frame.correlationId === expectedId, () => `heard ${JSON.stringify(got)}`);
    });
    return heard.length;
  } else if ('ended' in stated) {
    for (const [name, members] of Object.entries(object(stated['ended'], 'ended'))) {
      for (const member of strings(members, 'ended')) {
        check(hasEnded(stateOf(world, name, member)), () => `${name}.${member} has not ended`);
      }
    }
  } else if ('busDestroyed' in stated) {
    check(client.bus.destroyed === stated['busDestroyed'], () => `the client's bus is${client.bus.destroyed ? '' : ' not'} destroyed`);
  } else {
    throw new Error('no step this runner performs');
  }
  return told;
}

async function play(stated: Case): Promise<void> {
  const make = MAKERS[stated.unit];
  if (make === undefined) throw new Error(`this runner makes no ${stated.unit}`);
  const { client, transport } = createTestClient({ transport: transportOf(stated.transport) });
  for (const [operation, responses] of Object.entries(object(stated.transport['replies'] ?? {}, 'transport.replies'))) {
    if (!Array.isArray(responses)) throw new Error(`the replies to ${operation} are not a list`);
    transport.queueReply(operation as BusOperationKey, ...responses.map(resolved));
  }
  const searches = new Searches();
  const units: Record<string, Played> = {};
  for (const [name, given] of Object.entries(stated.made)) units[name] = make(client, searches, given);
  const heard: Heard[] = [];
  // Taken now, before anything runs, so what is said from the moment the units are made is heard.
  const listening = (stated.listen ?? []).map((channel) =>
    client.bus.frames(channel as keyof EventMap).subscribe((frame) => {
      heard.push({ channel, payload: frame.payload, correlationId: frame.correlationId });
    }),
  );
  const world: World = { client, transport, searches, units, heard };
  let told = 0;
  try {
    for (const [at, step] of stated.steps.entries()) {
      try {
        told = await perform(step, world, told);
      } catch (broken) {
        throw new Error(`steps[${at}] ${JSON.stringify(step)}: ${broken instanceof Error ? broken.message : String(broken)}`);
      }
    }
  } finally {
    for (const unit of Object.values(units)) unit.unit.dispose();
    for (const listener of listening) listener.unsubscribe();
    await settle();
    client.dispose();
  }
}

// ── The tests ───────────────────────────────────────────────────────────

describe('the state units against specs/src/client/state-units.json', () => {
  beforeEach(() => {
    // The microtasks the test transport answers on stay real; the clock is held.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('makes each unit it has cases of, and no other', () => {
    // A unit the table states no case of (the cache, whose behaviour its own tables hold) needs no maker here.
    expect(new Set(Object.keys(MAKERS))).toEqual(new Set(RUN.map((stated) => stated.unit)));
  });

  it('runs only cases of units the names table has', () => {
    const named = new Set(NAMES.stateUnits.map((row) => row.unit));
    expect(TABLE.cases.filter((stated) => !named.has(stated.unit)).map((stated) => stated.unit)).toEqual([]);
  });

  it.each(RUN.map((stated) => [`${stated.unit}: ${stated.case}`, stated] as const))('%s', async (_name, stated) => {
    await play(stated);
  });

  it('fails a case whose check is wrong', async () => {
    const match = RUN.find((stated) => stated.unit === 'match');
    if (match === undefined) throw new Error('the table has no case of match');
    const told: Case = structuredClone(match);
    told.steps = told.steps.map((step) =>
      step !== null && typeof step === 'object' && !Array.isArray(step) && 'heard' in step ? { ...step, heard: [] } : step,
    );
    await expect(play(told)).rejects.toThrow(/heard/);
  });
});
