/**
 * What bounds a request whose credential is refused (the bearer scheme's
 * `x-semiont-limits`: `refusalsPerSecond`, `refusalBurst`, `refusalHolders`).
 *
 * A refused request is counted against the holder its token names, read
 * without verifying it: the token's `iss`, and the claim the gateway names a
 * holder by — the subject claim for the trusted issuer's tokens, `did` for any
 * other. Past its holder's allowance, a refused request is answered 429
 * `refusal-rate` and told when to return. A request that names no holder is
 * counted in one count of its own. A token that verifies is never counted, and
 * never limited, whatever its holder's count.
 *
 * The cases run in order on one gateway, and only the last fills the count of
 * requests that name no holder: the ones before it rely on its being empty.
 */
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { call, nonConformance, type Reply } from '../harness/http';
import { spec } from '../harness/spec';
import { eachPlane, type World } from '../harness/world';

const ME = '/api/users/me';
const burst = () => spec().schemeLimit('bearerAuth', 'refusalBurst');
const holders = () => spec().schemeLimit('bearerAuth', 'refusalHolders');

/** An issuer token for `sub` that has expired: refused, and naming its holder. */
const expired = (world: World, sub: string): Promise<string> =>
  world.issuer.fixture.token({ expiresIn: new Date(Date.now() - 60_000), claims: { sub, email: `${sub}@people.example`, jti: randomUUID() } });

/** A token naming the agent `did`, signed with a key the gateway does not hold: refused, and naming its holder. */
const forgedAgent = (world: World, did: string): Promise<string> =>
  world.signed({ did, iss: 'kb.example', email: 'agent@agents.kb.example', jti: randomUUID() }, 'a key the gateway does not hold');

const agentDid = () => `did:web:kb.example:agents:refused:${randomUUID()}`;

/** `count` tokens, made before any is sent, so sending them takes no longer than the sending. */
const tokens = (count: number, make: () => Promise<string>): Promise<string[]> => Promise.all(Array.from({ length: count }, make));

const ask = (world: World, token?: string, authorization?: string): Promise<Reply> =>
  call(world.origin, 'GET', ME, token !== undefined ? { token } : authorization !== undefined ? { headers: { authorization } } : {});

/** Every token sent at once; what each was answered. */
const sendAll = (world: World, sent: string[]): Promise<Reply[]> => Promise.all(sent.map((token) => ask(world, token)));

/** The refusals past the allowance: each a conforming 429 `refusal-rate` that says when to return. */
function pastTheAllowance(replies: Reply[], why: string): Reply[] {
  expect(replies.map((r) => r.status).filter((s) => s !== 401 && s !== 429), `${why}: every request refused, 401 or 429`).toEqual([]);
  const limited = replies.filter((r) => r.status === 429);
  for (const reply of limited.slice(0, 3)) {
    expect(nonConformance('get', ME, reply), why).toEqual([]);
    expect((reply.json as { code: string }).code, why).toBe('refusal-rate');
    expect(Number(reply.headers.get('retry-after')), `${why}: Retry-After`).toBeGreaterThanOrEqual(1);
  }
  return limited;
}

eachPlane('what bounds a refused request', (world) => {
  it('refused requests naming one holder, each with a different token, are answered 401 up to the allowance and 429 refusal-rate past it', async () => {
    const sub = `refused-${randomUUID()}`;
    const replies = await sendAll(world(), await tokens(burst() + 20, () => expired(world(), sub)));
    expect(pastTheAllowance(replies, 'one holder').length, 'refused past the allowance').toBeGreaterThan(0);
    expect(replies.filter((r) => r.status === 401).length, 'a holder new to the gateway starts with its whole allowance').toBeGreaterThanOrEqual(burst());
  });

  it('a token that verifies is served whatever its holder\'s count: the same subject\'s, and another\'s', async () => {
    const sub = `refused-${randomUUID()}`;
    const draining = await tokens(burst() + 20, () => expired(world(), sub));
    const meanwhile = await tokens(20, () => expired(world(), sub));
    const [good, other] = [await world().person(sub), await world().person(`another-${randomUUID()}`)];
    expect(pastTheAllowance(await sendAll(world(), draining), 'one holder').length, 'the holder is past its allowance').toBeGreaterThan(0);

    const [served, alsoServed, ...refused] = await Promise.all([ask(world(), good), ask(world(), other), ...meanwhile.map((token) => ask(world(), token))]);
    expect(pastTheAllowance(refused, 'the same holder, meanwhile').length, 'its refused tokens are still limited').toBeGreaterThan(0);
    expect(served!.status, 'its good token is served').toBe(200);
    expect(alsoServed!.status, 'another holder is served').toBe(200);
  });

  it('refused agent tokens are counted by their did: two dids apart, and neither in the count of requests that name no holder', async () => {
    const a = agentDid();
    const draining = await tokens(burst() + 20, () => forgedAgent(world(), a));
    const another = await forgedAgent(world(), agentDid());
    expect(pastTheAllowance(await sendAll(world(), draining), 'one agent').length, 'the agent is past its allowance').toBeGreaterThan(0);

    const [b, unnamed] = await Promise.all([ask(world(), another), ask(world())]);
    expect(b.status, 'another did is counted apart').toBe(401);
    expect(unnamed.status, 'the agent\'s refusals are not in the count of requests that name no holder').toBe(401);
  });

  it('the gateway counts at most refusalHolders holders: a new one drops the oldest, which starts again with its whole allowance', async () => {
    const oldest = agentDid();
    const draining = await tokens(burst() + 20, () => forgedAgent(world(), oldest));
    const newcomers = await tokens(holders(), () => forgedAgent(world(), agentDid()));
    const again = await tokens(burst(), () => forgedAgent(world(), oldest));
    expect(pastTheAllowance(await sendAll(world(), draining), 'the oldest').length, 'the oldest is past its allowance').toBeGreaterThan(0);

    // As many new holders as the gateway counts, each refused once: every holder it counted before is dropped.
    for (let at = 0; at < newcomers.length; at += 64) {
      const replies = await sendAll(world(), newcomers.slice(at, at + 64));
      expect(replies.map((r) => r.status).filter((s) => s !== 401), 'a newcomer starts with its whole allowance').toEqual([]);
    }

    // Dropped, the oldest starts again with its whole allowance: a whole burst at once is refused 401, none 429.
    // Kept, it would hold only what it earned back since it was drained: less than a burst, while that took
    // under refusalBurst ÷ refusalsPerSecond seconds.
    const replies = await sendAll(world(), again);
    expect(replies.map((r) => r.status).filter((s) => s !== 401), 'the oldest was dropped, and starts again').toEqual([]);
  });

  it('a request with no token, and one whose bearer is not a token, share one count; filling it limits no request whose token names a holder', async () => {
    const [named, agent] = [await expired(world(), `refused-${randomUUID()}`), await forgedAgent(world(), agentDid())];
    const unnamed = await Promise.all(Array.from({ length: burst() + 20 }, (_, i) => (i % 2 === 0 ? ask(world()) : ask(world(), undefined, 'Bearer not-a-token'))));
    expect(pastTheAllowance(unnamed, 'no holder').length, 'the shared count is past its allowance').toBeGreaterThan(0);

    const [person, software] = await Promise.all([ask(world(), named), ask(world(), agent)]);
    expect(person.status, 'a refused token naming a person is its holder\'s to count').toBe(401);
    expect(software.status, 'so is a refused agent token, named by its did').toBe(401);
  });
});
