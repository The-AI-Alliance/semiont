//! Match: searching, for what a reference could refer to and for resources
//! by text. The second is a query (`Cached`): it answers from the client's
//! cache, and the client's refresher (`super::refresher`) keeps it true.

use super::browse::ResourceFilters;
use crate::cache::Cache;
use crate::cached::{Cached, Keyed};
use crate::channels::{MatchResourcesRequested, MatchSearchRequested};
use crate::client::Links;
use crate::errors::SemiontError;
use crate::running::Running;
use crate::state_unit::StateUnit;
use crate::transport::Envelope;
use crate::types::{
    MatchResourcesRequest, MatchResourcesResponse, MatchSearchRequest, MatchSearchResult,
};
use serde_json::Value;

/// How many candidates a search gives when its caller states no limit.
/// Every SDK asks for as many: the cases of specs/src/client/surface.json
/// hold each to it.
const LIMIT: i64 = 10;

/// A search for resources: the text, and which resources it is among.
pub(super) type ResourceSearch = (String, ResourceFilters);

pub struct MatchNamespace {
    links: Links,
    /// What each search asked for found. Kept as long as the client is.
    pub(super) searches: Cache<ResourceSearch, MatchResourcesResponse>,
}

impl MatchNamespace {
    pub(crate) fn new(links: Links) -> MatchNamespace {
        let searches = Cache::new({
            let links = links.clone();
            move |(search, filters): ResourceSearch| {
                let links = links.clone();
                async move {
                    let request = MatchResourcesRequest {
                        search,
                        limit: Some(filters.limit()),
                        archived: filters.archived,
                        entity_type: filters.entity_type,
                        offset: Some(0),
                    };
                    let answer = links.request::<MatchResourcesRequested>(&request).await?;
                    Ok(answer.response)
                }
            }
        });
        MatchNamespace { links, searches }
    }

    /// End the query: every watcher's stream ends.
    pub(crate) fn dispose(&self) {
        self.searches.dispose();
    }

    /// A page of the resources among those `filters` admits that a search
    /// for `search` finds, kept per search and set of filters. The text is
    /// matched lexically and, when nothing matches, by meaning: the
    /// answer's `match_kind` says which it is. A search is a query's
    /// answer: it is asked for again when a resource is created, updated,
    /// cloned or moved, and when a dropped stream reopens, and not by a
    /// change to a resource whose scope the client does not hold.
    pub fn resources(
        &self,
        search: &str,
        filters: ResourceFilters,
    ) -> Cached<MatchResourcesResponse> {
        Cached::of(Keyed {
            cache: self.searches.clone(),
            key: (search.to_owned(), filters),
            view: |value| value,
            scope: None,
        })
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

impl Drop for MatchNamespace {
    fn drop(&mut self) {
        self.dispose();
    }
}
