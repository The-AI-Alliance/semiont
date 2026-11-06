/**
 * An exchange that has `ms` to end. `exchange` is given a signal that is
 * aborted with a `TimeoutError` once `ms` have passed, and the wait is let go
 * when the exchange ends, however it ends. The wait is a timer global, which
 * a test's fake timers move; `AbortSignal.timeout` keeps its wait natively,
 * where no fake reaches it.
 *
 * Whatever reads the answer belongs inside `exchange`: a body read after it
 * has ended has no deadline.
 */
export async function withinDeadline<T>(ms: number, exchange: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const deadline = new AbortController();
  const timer = setTimeout(() => {
    deadline.abort(new DOMException(`The deadline of ${ms}ms passed`, 'TimeoutError'));
  }, ms);
  try {
    return await exchange(deadline.signal);
  } finally {
    clearTimeout(timer);
  }
}
