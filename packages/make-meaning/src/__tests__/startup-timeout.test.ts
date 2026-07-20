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
    await expect(withStartupTimeout('Graph database', Promise.resolve('ok'))).resolves.toBe('ok');
  });

  it('propagates the original error rather than masking it', async () => {
    const boom = new Error('ECONNREFUSED 127.0.0.1:7687');
    await expect(withStartupTimeout('Graph database', Promise.reject(boom))).rejects.toThrow(
      'ECONNREFUSED',
    );
  });

  it('rejects — naming the dependency — when the connect never settles', async () => {
    vi.useFakeTimers();
    const never = new Promise<string>(() => {});
    const raced = withStartupTimeout('Vector store', never);
    const assertion = expect(raced).rejects.toThrow(/Vector store did not become available/);
    await vi.advanceTimersByTimeAsync(STARTUP_CONNECT_TIMEOUT_MS + 1);
    await assertion;
  });

  it('does not leave a pending timer holding the event loop open', async () => {
    vi.useFakeTimers();
    await withStartupTimeout('Embedding provider', Promise.resolve(1));
    expect(vi.getTimerCount()).toBe(0);
  });
});
