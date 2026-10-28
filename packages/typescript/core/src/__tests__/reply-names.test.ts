/**
 * What a reply states beside its `response` is derived from its schema, and
 * the derivation refuses a reply nothing could fill.
 *
 * A reply names what it answers for by stating a property of its request
 * again: the resource a context was gathered for, the reference a search was
 * for. `replyNames` reads each operation's list from the component schema of
 * its reply (what it requires, without `response`); `generate-ts.mjs` prints
 * the result as `REPLY_NAMES`, which `FaultyTransport` answers from.
 *
 * Each case hands the derivation a small registry and the schemas it names.
 * The first is the control: a registry that can be meant is derived from.
 */

import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';

interface Schema {
  type?: string;
  properties?: Record<string, unknown>;
  required?: string[];
  allOf?: unknown[];
}

interface Channel {
  channel: string;
  shape: string;
  schema?: string;
}

interface Registry {
  channels: Channel[];
  operations: { request: string; result: string; failure: string }[];
}

type ReplyNames = (registry: Registry, schemaOf: (name: string) => Schema) => Map<string, string[]>;

const { replyNames }: { replyNames: ReplyNames } = await import(
  fileURLToPath(new URL('../../../../scripts/bus/reply-names.mjs', import.meta.url))
);

/** One operation, whose reply states the `demoId` its request stated. */
function registry(): Registry {
  return {
    channels: [
      { channel: 'demo:requested', shape: 'schema', schema: 'DemoRequest' },
      { channel: 'demo:result', shape: 'schema', schema: 'DemoResult' },
      { channel: 'demo:failed', shape: 'schema', schema: 'CommandError' },
    ],
    operations: [{ request: 'demo:requested', result: 'demo:result', failure: 'demo:failed' }],
  };
}

function schemas(): Record<string, Schema> {
  return {
    DemoRequest: {
      type: 'object',
      properties: { demoId: { type: 'string' }, depth: { type: 'integer' } },
      required: ['demoId'],
    },
    DemoResult: {
      type: 'object',
      properties: { demoId: { type: 'string' }, response: { type: 'string' } },
      required: ['demoId', 'response'],
    },
  };
}

/** Reads `from`, and refuses a schema it does not hold as the generator's reader refuses a missing file. */
function reader(from: Record<string, Schema>): (name: string) => Schema {
  return (name) => {
    const schema = from[name];
    if (schema === undefined) throw new Error(`no schema ${name}`);
    return schema;
  };
}

describe('replyNames: what each reply states beside its response', () => {
  it('reads the names a reply requires, and every operation has a list', () => {
    expect(replyNames(registry(), reader(schemas()))).toStrictEqual(new Map([['demo:requested', ['demoId']]]));
  });

  it('a reply that requires its response alone, or nothing, names nothing', () => {
    const responseAlone = schemas();
    responseAlone['DemoResult'] = { type: 'object', properties: { response: { type: 'string' } }, required: ['response'] };
    expect(replyNames(registry(), reader(responseAlone)).get('demo:requested')).toStrictEqual([]);

    const nothing = schemas();
    nothing['DemoResult'] = { type: 'object', properties: {} };
    expect(replyNames(registry(), reader(nothing)).get('demo:requested')).toStrictEqual([]);
  });

  it('a property a reply may state and does not require is not a name', () => {
    const optional = schemas();
    optional['DemoResult'] = {
      type: 'object',
      properties: { demoId: { type: 'string' }, response: { type: 'string' } },
      required: ['response'],
    };
    expect(replyNames(registry(), reader(optional)).get('demo:requested')).toStrictEqual([]);
  });

  it.each(['envelope', 'empty', 'void'])('a reply of shape %s names nothing, and no schema is read for it', (shape) => {
    const reg = registry();
    reg.channels[1] = { channel: 'demo:result', shape };
    expect(replyNames(reg, reader({})).get('demo:requested')).toStrictEqual([]);
  });

  it('refuses a name the request does not state', () => {
    const unstated = schemas();
    unstated['DemoRequest'] = { type: 'object', properties: { depth: { type: 'integer' } } };
    expect(() => replyNames(registry(), reader(unstated))).toThrow(
      'demo:result names "demoId" beside its response, which demo:requested does not state',
    );
  });

  it('refuses a reply whose schema is composed: what it requires is not read from its own list', () => {
    const composed = schemas();
    composed['DemoResult'] = { allOf: [{ type: 'object', required: ['demoId', 'response'] }] };
    expect(() => replyNames(registry(), reader(composed))).toThrow('demo:result carries DemoResult, which is composed with allOf');
  });

  it('refuses a reply that is a persisted event, which states no response to name anything beside', () => {
    const reg = registry();
    reg.channels[1] = { channel: 'demo:result', shape: 'storedEvent' };
    expect(() => replyNames(reg, reader(schemas()))).toThrow('demo:result is the reply to demo:requested and has shape "storedEvent"');
  });
});
