import { describe, it, expect, vi, afterEach } from 'vitest';
import { withStartupTimeout, STARTUP_CONNECT_TIMEOUT_MS } from '../service';

// A dependency that never answers used to hang the process forever: Docker's
// `restart: on-failure` only rescues a process that EXITS, so an unbounded
// startup connect left the container unhealthy indefinitely (observed on a
// Codespaces resume, where every service restarts at once and `depends_on`
// does not apply). These tests pin the conversion of that hang into a crash.
describe('withStartupTimeout', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('passes a value through untouched when the dependency answers', async () => {
    await expect(withStartupTimeout('Graph database', () => Promise.resolve('ok'))).resolves.toBe('ok');
  });

  it('propagates the original error rather than masking it', async () => {
    const boom = new Error('ECONNREFUSED 127.0.0.1:7687');
    await expect(withStartupTimeout('Graph database', () => Promise.reject(boom))).rejects.toThrow(
      'ECONNREFUSED',
    );
  });

  it('rejects — naming the dependency — when the connect never settles', async () => {
    vi.useFakeTimers();
    const never = new Promise<string>(() => {});
    const raced = withStartupTimeout('Vector store', () => never);
    const assertion = expect(raced).rejects.toThrow(/Vector store did not become available/);
    await vi.advanceTimersByTimeAsync(STARTUP_CONNECT_TIMEOUT_MS + 1);
    await assertion;
  });

  it('does not leave a pending timer holding the event loop open', async () => {
    vi.useFakeTimers();
    await withStartupTimeout('Embedding provider', () => Promise.resolve(1));
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('the deadline reaches the work, not just the race', () => {
  it('hands the work an AbortSignal that fires at the deadline', async () => {
    // The change that makes the hazard unbuildable rather than documented. The
    // race alone could only ABANDON slow work; work that RETRIES never learned a
    // deadline existed, so a boot path whose retry outlived this timeout would be
    // killed just before it succeeded — and the only protection was two numbers
    // being kept compatible by hand, in two packages.
    vi.useFakeTimers();
    let seen: AbortSignal | undefined;
    const raced = withStartupTimeout('Vector store', (signal) => {
      seen = signal;
      return new Promise<string>(() => {});
    });
    const assertion = expect(raced).rejects.toThrow(/did not become available/);

    expect(seen).toBeInstanceOf(AbortSignal);
    expect(seen!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(STARTUP_CONNECT_TIMEOUT_MS + 1);
    await assertion;
    expect(seen!.aborted).toBe(true);
  });
});
