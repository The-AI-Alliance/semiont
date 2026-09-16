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
      { channel: 'demo:requested', shape: 'schema', validate: 'DemoRequest' },
      { channel: 'demo:result', shape: 'schema', validate: 'DemoResult' },
      { channel: 'demo:failed', shape: 'schema', validate: 'CommandError' },
      { channel: 'demo:happened', shape: 'schema', validate: 'DemoEvent' },
      { channel: 'demo:internal', shape: 'schema', validate: 'DemoInternal' },
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
    reg.channels.push({ channel: 'demo:do-it', shape: 'schema', validate: 'DemoCommand' });
    reg.kind.command = ['demo:do-it'];
    reg.audience.everyone = [...reg.audience.everyone, 'demo:do-it'];
    expect(complains(reg, 'demo:do-it')).toBe(true);
  });

  test('refuses an axis naming a channel that channels[] does not declare', () => {
    const reg = baseRegistry();
    reg.audience.declared = ['demo:typo'];
    expect(complains(reg, 'demo:typo')).toBe(true);
  });
});
