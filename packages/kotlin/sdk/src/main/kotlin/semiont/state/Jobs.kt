package semiont.state

import semiont.errors.JobError
import semiont.errors.JobErrorCode
import semiont.errors.SemiontError

/** Whether a job ended because it was cancelled: its commits stand, and its display stays to say so. */
internal fun cancelled(failure: SemiontError): Boolean = failure is JobError && failure.reason == JobErrorCode.Cancelled
