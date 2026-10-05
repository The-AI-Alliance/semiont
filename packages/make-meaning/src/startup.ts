/**
 * How long a boot waits for a dependency, and why exiting is the right end.
 *
 * Docker's `restart: on-failure` only rescues a process that EXITS; an unbounded
 * await on a slow dependency hangs forever and the container sits unhealthy.
 * On a Codespaces resume every container restarts at once and `depends_on`
 * does not apply — it governs `compose up`, not daemon-driven restarts — so
 * connects can reach Neo4j/Qdrant/Ollama before they are listening.
 *
 * 60s is this fleet's answer, not a general one, which is why it lives here and
 * `withDeadline` lives in core. It can be raced by work that retries — the
 * embedding provider waits ~5 min — and that is safe because `withDeadline` hands
 * the deadline down: the retry stops when this fires instead of being abandoned
 * mid-flight.
 */
export const STARTUP_CONNECT_TIMEOUT_MS = 60_000;

/** Operator context core cannot know: something is watching for the exit. */
export const RESTART_HINT =
  'Exiting so the container restart policy can retry — it is normal for a dependency ' +
  'to be slow when every service restarts at once.';
