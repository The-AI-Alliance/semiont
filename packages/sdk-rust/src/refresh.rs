//! What refreshes a client's cache, generated from
//! specs/src/client/refresh.json, the table every SDK applies: a row per
//! trigger, saying which live queries it asks again for (`refetches`), which
//! it writes with the value the event carries (`writes`), and which it ends,
//! their entity being gone (`removes`). `crate::namespaces::BrowseNamespace`
//! applies it, and states for itself only what each event names.

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

/// What one trigger does to the cache.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CacheRefresh {
    pub when: Option<RefreshWhen>,
    pub reach: Reach,
    /// Asked for again, the value shown meanwhile.
    pub refetches: &'static [CacheQuery],
    /// Written with the value the event carries.
    pub writes: &'static [CacheQuery],
    /// Gone: the key fails as `bus.not-found`.
    pub removes: &'static [CacheQuery],
}

include!(concat!(env!("OUT_DIR"), "/cache_refresh.rs"));
