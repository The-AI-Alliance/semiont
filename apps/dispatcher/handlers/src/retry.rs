//! Whether a failed attempt is retried: exactly when the failure is not known
//! to be deterministic and the job has retries left, on the record before the
//! failure is applied. The worker computes the same answer for `willRetry`;
//! specs/src/jobs/retry-cases.json holds both to it.

use semiont::types::{FailureClass, JobMetadata};

pub fn will_retry_after(metadata: &JobMetadata, failure_class: Option<FailureClass>) -> bool {
    failure_class != Some(FailureClass::Deterministic)
        && metadata.retry_count < metadata.max_retries
}
