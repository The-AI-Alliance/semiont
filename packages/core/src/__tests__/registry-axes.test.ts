/**
 * RED (WIRE-CROSSING-MODEL P1): the registry declares HOW a channel crosses,
 * on two axes, and refuses to generate when it does not.
 *
 * The classes being replaced were honest individually and dishonest as a set:
 * `bridgedBroadcasts` conflated "crosses as fan-out" with "every default
 * client auto-subscribes"; `outboundCommands` held three different shapes
 * under one label; and `inProcess` claimed "never crosses" for eleven
 * channels that are scope-delivered to browsers every day. Five bring-up
 * blockers in one week were mis-answers to "how does this channel cross?".
 *
 * The axes are `kind` (operation | command | event) and `audience`
 * (everyone | scoped | declared). `kind`, not `shape`: `channels[]` entries
 * already carry a `shape` field meaning the PAYLOAD shape, and two facts
 * under one key in one file is the disease, not the cure.
 *
 * These refusals are asserted against the IMPORTABLE validator rather than by
 * mutating the real registry and reading a stack trace, so each one is
 * watched failing on every run instead of once by hand.
 */
import { describe, test, expect } from 'vitest';
import { createRequire } from 'module';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const SCRIPTS = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../scripts/bus');

// The validator is ESM (.mjs) outside this workspace; import it by path.
const { validateRegistry } = await import(`${SCRIPTS}/validate-registry.mjs`);
void require;

/** A minimal but VALID registry: one operation, one event, nothing else. */
function baseRegistry() {
  return {
    channels: [
      { channel: 'demo:requested', shape: 'schema', schema: 'DemoRequest', validate: 'DemoRequest' },
      { channel: 'demo:result', shape: 'schema', schema: 'DemoResult', validate: 'DemoResult' },
      { channel: 'demo:failed', shape: 'schema', schema: 'CommandError', validate: 'CommandError' },
      { channel: 'demo:happened', shape: 'schema', schema: 'DemoEvent', validate: 'DemoEvent' },
      { channel: 'demo:internal', shape: 'schema', schema: 'DemoInternal', validate: 'DemoInternal' },
    ],
    operations: [{ request: 'demo:requested', result: 'demo:result', failure: 'demo:failed' }],
    kind: { doc: [], command: [] as string[], event: ['demo:happened'] as string[] },
    audience: {
      doc: [],
      everyone: ['demo:happened'] as string[],
      scoped: [] as string[],
      declared: [] as string[],
    },
    inProcess: { doc: [], channels: ['demo:internal'] },
    resourceBroadcasts: { channels: [], bodyComment: [] },
    // The third axis: does emitting it CHANGE the knowledge base? Its domain
    // is the emittable set — an operation's request, or a kind.command —
    // which here is `demo:requested` alone.
    effect: { doc: '', writes: ['demo:requested'] as string[], reads: [] as string[] },
  };
}

/** `validateRegistry` THROWS on problems and returns nothing when clean. */
function problemsFor(reg: unknown): string {
  try {
    validateRegistry(reg);
    return '';
  } catch (err) {
    return (err as Error).message;
  }
}
const complains = (reg: unknown, needle: string) =>
  problemsFor(reg).toLowerCase().includes(needle.toLowerCase());

describe('registry axes — a channel declares HOW it crosses, or refuses to generate', () => {
  test('the base registry is valid — the fixture is not proving refusals by being broken', () => {
    expect(problemsFor(baseRegistry())).toBe('');
  });

  test('refuses a wire-crossing channel with NO audience', () => {
    const reg = baseRegistry();
    reg.audience.everyone = [];
    expect(
      complains(reg, 'demo:happened'),
      'a channel that crosses must say who receives it — there is no default',
    ).toBe(true);
  });

  test('refuses a non-operation wire-crossing channel with NO kind', () => {
    const reg = baseRegistry();
    reg.kind.event = [];
    expect(complains(reg, 'demo:happened')).toBe(true);
  });

  test('refuses a channel declared in TWO audiences', () => {
    const reg = baseRegistry();
    reg.audience.scoped = ['demo:happened'];
    expect(complains(reg, 'demo:happened')).toBe(true);
  });

  test('refuses a channel that is both inProcess and given an audience', () => {
    const reg = baseRegistry();
    reg.audience.declared = ['demo:internal'];
    expect(
      complains(reg, 'demo:internal'),
      'inProcess means it never crosses; an audience means it does',
    ).toBe(true);
  });

  test('refuses an OPERATION channel given a hand-written kind or audience', () => {
    // An operation's kind and audience are DERIVED from `operations`.
    // Restating them is a mirror with no gate, and the two can disagree.
    const reg = baseRegistry();
    reg.kind.event = [...reg.kind.event, 'demo:result'];
    expect(complains(reg, 'demo:result')).toBe(true);
  });

  test('refuses kind=command with audience=everyone', () => {
    // The P0 audit found no member wanting this pairing. Leaving it
    // expressible would leave it untested: a directive for one handler,
    // broadcast to every browser.
    const reg = baseRegistry();
    reg.channels.push({ channel: 'demo:do-it', shape: 'schema', schema: 'DemoCommand', validate: 'DemoCommand' });
    reg.kind.command = ['demo:do-it'];
    reg.audience.everyone = [...reg.audience.everyone, 'demo:do-it'];
    expect(complains(reg, 'demo:do-it')).toBe(true);
  });

  test('refuses an axis naming a channel that channels[] does not declare', () => {
    const reg = baseRegistry();
    reg.audience.declared = ['demo:typo'];
    expect(complains(reg, 'demo:typo')).toBe(true);
  });

  test('refuses an emittable channel with NO effect', () => {
    const reg = baseRegistry();
    reg.effect.writes = [];
    expect(
      complains(reg, 'declares no effect'),
      'the gateway reads this to decide whether an emit was an act — a gap reads as "no act"',
    ).toBe(true);
  });

  test('refuses a channel declared BOTH a write and a read', () => {
    const reg = baseRegistry();
    reg.effect.reads = ['demo:requested'];
    expect(complains(reg, 'both effect.writes and effect.reads')).toBe(true);
  });

  test('refuses an effect declared for a channel nobody emits', () => {
    const reg = baseRegistry();
    reg.effect.reads = ['demo:happened'];
    expect(
      complains(reg, 'which nobody emits'),
      'an event is delivered, never emitted at the gateway — the question does not arise',
    ).toBe(true);
  });

});

/**
 * A channel states its payload in a form every language can read: a `shape`,
 * and the component schema or stored event that shape names. The registry used
 * to carry the TypeScript type of every channel as a `ts` string, and for 34
 * `custom` channels that string was the only statement there was, so no other
 * SDK could type them.
 */
describe('registry payloads — stated by shape, never as a TypeScript string', () => {
  /** The base registry with one more in-process channel, as given. */
  function withChannel(entry: Record<string, unknown>) {
    const reg = baseRegistry();
    return {
      ...reg,
      channels: [...reg.channels, { channel: 'demo:extra', ...entry }],
      inProcess: { doc: [], channels: [...reg.inProcess.channels, 'demo:extra'] },
    };
  }

  test('accepts each of the five shapes', () => {
    for (const entry of [
      { shape: 'schema', schema: 'DemoExtra', validate: null },
      { shape: 'schema', schema: 'DemoExtra', validate: null, tsRefinement: 'DemoExtraRefined' },
      { shape: 'envelope', schema: 'DemoExtra', validate: null },
      { shape: 'void', validate: null },
      { shape: 'empty', validate: null },
    ]) {
      expect(problemsFor(withChannel(entry)), JSON.stringify(entry)).toBe('');
    }
    const stored = baseRegistry();
    const reg = {
      ...stored,
      channels: [
        ...stored.channels,
        { channel: 'demo:stored', shape: 'storedEvent', event: 'demo:stored', payload: 'DemoStoredPayload', validate: null },
        { channel: 'demo:system', shape: 'storedEvent', event: 'demo:system', payload: 'DemoSystemPayload', system: true, validate: null },
        {
          channel: 'demo:branded',
          shape: 'storedEvent',
          event: 'demo:branded',
          payload: 'DemoBrandedPayload',
          validate: null,
          tsRefinement: "components['schemas']['DemoBrandedPayload'] & { id: DemoId }",
        },
      ],
      inProcess: { doc: [], channels: [...stored.inProcess.channels, 'demo:stored', 'demo:system', 'demo:branded'] },
    };
    expect(problemsFor(reg)).toBe('');
  });

  test('refuses the custom shape — a payload only TypeScript can read', () => {
    expect(complains(withChannel({ shape: 'custom', validate: null }), 'has shape "custom"')).toBe(true);
  });

  test('refuses a ts string — the TypeScript type is derived', () => {
    const reg = withChannel({ shape: 'schema', schema: 'DemoExtra', validate: null, ts: "components['schemas']['DemoExtra']" });
    expect(complains(reg, 'carries a ts string')).toBe(true);
  });

  test('refuses a schema-carrying shape that names no schema', () => {
    expect(complains(withChannel({ shape: 'schema', validate: null }), 'must name its schema')).toBe(true);
    expect(complains(withChannel({ shape: 'envelope', validate: null }), 'must name its schema')).toBe(true);
  });

  test('refuses a schema on a shape that carries none', () => {
    expect(complains(withChannel({ shape: 'void', schema: 'DemoExtra', validate: null }), 'names no schema')).toBe(true);
    expect(complains(withChannel({ shape: 'empty', schema: 'DemoExtra', validate: null }), 'names no schema')).toBe(true);
  });

  test('refuses a refinement with no schema to narrow', () => {
    const reg = withChannel({ shape: 'empty', validate: null, tsRefinement: 'Whatever' });
    expect(complains(reg, 'a refinement narrows a schema')).toBe(true);
  });

  test('refuses a channel that carries one schema and validates against another', () => {
    const reg = withChannel({ shape: 'schema', schema: 'DemoExtra', validate: 'DemoOther' });
    expect(complains(reg, 'one channel, one schema')).toBe(true);
  });

  test('refuses a validate schema on a channel that carries no schema', () => {
    const reg = withChannel({ shape: 'empty', validate: 'DemoExtra' });
    expect(complains(reg, 'only a channel that carries a schema can be validated')).toBe(true);
  });

  test('refuses a stored event published on a channel other than its own type', () => {
    const reg = withChannel({ shape: 'storedEvent', event: 'demo:other', payload: 'DemoPayload', validate: null });
    expect(complains(reg, 'published on the channel of its own type')).toBe(true);
  });

  // Which payload belongs to which event was a hand-written TypeScript
  // catalog, so no other language could type a stored event.
  test('refuses a stored event that names no payload schema', () => {
    const reg = withChannel({ shape: 'storedEvent', event: 'demo:extra', validate: null });
    expect(complains(reg, 'must name its payload schema')).toBe(true);
  });

  test('refuses a payload on a channel that is not a stored event', () => {
    const reg = withChannel({ shape: 'schema', schema: 'DemoExtra', payload: 'DemoExtra', validate: null });
    expect(complains(reg, 'names no payload')).toBe(true);
  });

  test('refuses the system flag anywhere but on a stored event, and as anything but true', () => {
    expect(complains(withChannel({ shape: 'empty', system: true, validate: null }), 'only a stored event can carry it')).toBe(true);
    const reg = withChannel({ shape: 'storedEvent', event: 'demo:extra', payload: 'DemoPayload', system: false, validate: null });
    expect(complains(reg, 'it is a flag (true or absent)')).toBe(true);
  });
});
