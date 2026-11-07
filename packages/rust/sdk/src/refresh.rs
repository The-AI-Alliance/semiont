//! What refreshes a client's cache, generated from
//! protocol/specs/src/client/refresh.json, the table every SDK applies: a row per
//! trigger, saying which live queries it asks again for (`refetches`), which
//! it writes with the value the event carries (`writes`), and which it ends,
//! their entity being gone (`removes`); and where in the event its resource,
//! its annotation and the value it carries are (`names`, `carries`). A client
//! applies it to the queries of its `browse`, `gather` and `match_`
//! namespaces, and states for itself only which namespace answers each query.

/// Which of a split channel's two kinds of event a row is for: one that
/// carries the annotation as it now is, or one that could not.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum RefreshWhen {
    Enriched,
    Unenriched,
}

/// Which keys a row acts on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Reach {
    /// The keys the event names.
    Subject,
    /// Every key the client holds.
    Held,
}

/// Where in an event (the frame's payload) a row that reaches its subject
/// finds the keys it acts on: each a way, the names of the members it is
/// within and its own. None, where the row names none.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RefreshNames {
    /// The way to the resource the event names, a `ResourceId`.
    pub resource: Option<&'static [&'static str]>,
    /// The way to the annotation the event names, an `AnnotationId`.
    pub annotation: Option<&'static [&'static str]>,
}

/// What one trigger does to the cache.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CacheRefresh {
    pub when: Option<RefreshWhen>,
    pub reach: Reach,
    pub names: RefreshNames,
    /// The way to the value the row writes, an `Annotation`.
    pub carries: Option<&'static [&'static str]>,
    /// Asked for again, the value shown meanwhile.
    pub refetches: &'static [CacheQuery],
    /// Written with the value the event carries.
    pub writes: &'static [CacheQuery],
    /// Gone: the key fails as `bus.not-found`.
    pub removes: &'static [CacheQuery],
}

include!(concat!(env!("OUT_DIR"), "/cache_refresh.rs"));
