//! Match: searching for what a reference could refer to.

use crate::channels::MatchSearchRequested;
use crate::client::Links;
use crate::errors::SemiontError;
use crate::running::Running;
use crate::transport::Envelope;
use crate::types::{MatchSearchRequest, MatchSearchResult};
use serde_json::Value;

/// How many candidates a search gives when its caller states no limit.
/// Every SDK asks for as many: the cases of specs/src/client/surface.json
/// hold each to it.
const LIMIT: i64 = 10;

pub struct MatchNamespace {
    links: Links,
}

impl MatchNamespace {
    pub(crate) fn new(links: Links) -> MatchNamespace {
        MatchNamespace { links }
    }

    /// Candidates for a reference, given its gathered context. A request
    /// that states no limit asks for ten, and one that does not say
    /// otherwise is scored semantically.
    pub fn search(&self, mut request: MatchSearchRequest) -> Running<MatchSearchResult> {
        let links = self.links.clone();
        request.limit.get_or_insert(LIMIT);
        request.use_semantic_scoring.get_or_insert(true);
        Running::new(|_| async move {
            links
                .request::<MatchSearchRequested>(&request)
                .await
                .map_err(with_the_search_failure)
        })
    }

    /// Signal: a search is wanted. The client's own state runs it, and
    /// answers under `correlation_id`.
    pub fn request_search(&self, input: MatchSearchRequest, correlation_id: &str) {
        self.links.signal::<MatchSearchRequested>(
            &input,
            Envelope {
                correlation_id: Some(correlation_id.to_owned()),
                scope: None,
            },
        );
    }
}

/// A search's failure says what went wrong under `error`, where every other
/// operation's says it under `message`.
fn with_the_search_failure(error: SemiontError) -> SemiontError {
    match error {
        SemiontError::Bus(mut failure) => {
            if let Some(said) = failure
                .failure
                .as_ref()
                .and_then(|payload| payload.get("error"))
                .and_then(Value::as_str)
            {
                failure.message = said.to_owned();
            }
            SemiontError::Bus(failure)
        }
        other => other,
    }
}
