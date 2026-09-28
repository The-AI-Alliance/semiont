/**
 * The job queue's subject namespace on the broker. Every job is published under
 * `jobs.<category>.<type>`, and the JOBS stream captures `jobs.>` — a JetStream
 * stream is a server-side subscription, so anything published under it is
 * persisted whichever client produced it. The ONE home of both facts: the
 * JetStream queue builds its subjects from the root, and a reader that must know
 * the stream's reach needs no queue implementation to learn it (the gateway
 * conformance suite checks the gateway publishes nothing into it).
 */
export const JOBS_SUBJECT_ROOT = 'jobs';

/** The JOBS stream's capture filter: every subject under the root. */
export const JOBS_STREAM_SUBJECTS = [`${JOBS_SUBJECT_ROOT}.>`] as const;
