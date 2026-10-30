package semiont

/** The waits a client keeps: specs/src/client/timing.json's, unless a caller that must not wait them out says otherwise. */
public data class ClientTiming @JvmOverloads constructor(
    /** How long a request of the bus waits for its reply. */
    public val busRequestMs: Long = Timings.BUS_REQUEST_TIMEOUT_MS,
    /** How long a followed job may say nothing before its follower asks for its status. */
    public val jobSilenceMs: Long = Timings.JOB_SILENCE_MS,
    /** How often a follower asks a job's status while it waits for the job to end. */
    public val jobStatusPollMs: Long = Timings.JOB_STATUS_POLL_MS,
)
