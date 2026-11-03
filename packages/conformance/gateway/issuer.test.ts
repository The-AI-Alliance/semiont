/**
 * The trusted issuer's key set as the gateway fetches it: the deadline one
 * fetch is given, and what a fetch that fails costs the requests after it.
 * The timings are the `bearerAuth` scheme's `x-semiont-limits` in
 * specs/src/openapi.json, whose description states the rule.
 *
 * Plane-independent, and slow: each world waits out a deadline or a cooldown.
 * Each has a world of its own, because the gateway holds the keys it fetched.
 */
import { expect, it } from 'vitest';
import { call, nonConformance, type Reply } from '../harness/http';
import { spec } from '../harness/spec';
import { eachPlane } from '../harness/world';

const DEADLINE_MS = spec().schemeLimit('bearerAuth', 'keyFetchDeadlineSeconds') * 1000;
const COOLDOWN_MS = spec().schemeLimit('bearerAuth', 'keyRefetchCooldownSeconds') * 1000;

const whoAmI = (origin: string, token: string): Promise<Reply> => call(origin, 'GET', '/api/users/me', { token });

function expectRefused(reply: Reply): void {
  expect(reply.status, reply.text).toBe(401);
  expect(nonConformance('get', '/api/users/me', reply)).toEqual([]);
}

eachPlane('an issuer that accepts a key fetch and never answers it', (world) => {
  it('refuses its tokens once the fetch\'s deadline passes, and a request made meanwhile waits for that fetch, not one of its own', async () => {
    world().issuer.keys.answer = 'silent';
    const started = Date.now();
    const first = whoAmI(world().origin, await world().person('stalled'));
    await new Promise((r) => setTimeout(r, DEADLINE_MS / 2));
    const second = whoAmI(world().origin, await world().person('behind'));
    for (const reply of await Promise.all([first, second])) expectRefused(reply);
    // Both by the first fetch's deadline: a second fetch, or a wait behind the
    // first, would have taken half a deadline longer at the least.
    expect(Date.now() - started).toBeLessThan(DEADLINE_MS * 1.3);
    expect(world().issuer.keys.fetches).toBe(1);
  }, DEADLINE_MS * 3);
}, {}, ['in-process']);

eachPlane('an issuer whose key set cannot be fetched', (world) => {
  it('is asked once per cooldown, however many of its tokens arrive, and its tokens are accepted once a fetch succeeds', async () => {
    world().issuer.keys.answer = 'failing';
    const token = await world().person('waiting');
    for (const reply of await Promise.all(Array.from({ length: 5 }, () => whoAmI(world().origin, token)))) expectRefused(reply);
    for (let n = 0; n < 5; n += 1) expectRefused(await whoAmI(world().origin, token));
    expect(world().issuer.keys.fetches).toBe(1);

    world().issuer.keys.answer = 'published';
    expectRefused(await whoAmI(world().origin, token));
    await new Promise((r) => setTimeout(r, COOLDOWN_MS + 1000));
    const after = await whoAmI(world().origin, token);
    expect(after.status, after.text).toBe(200);
    expect(world().issuer.keys.fetches).toBe(2);
  }, COOLDOWN_MS * 2 + 10_000);
}, {}, ['in-process']);
