//! What keeps a client's queries true: specs/src/client/refresh.json
//! (`crate::refresh`), applied to the caches of the namespaces that hold
//! queries. Each event on the bus, and the reopening of a dropped stream,
//! asks again for the queries its row names, writes the ones whose new value
//! the event carries, and ends the ones whose entity is gone.
//!
//! A client has one refresher. It states what each event names (its
//! resource, its annotation, the value it carries) and, for each query of
//! the table, which namespace's cache answers it: `gather` what refers to a
//! resource, `match_` the searches, `browse` the rest. Both are matches
//! over the table's own enums, so a trigger or a query added to the table
//! does not compile until it is answered here.
//!
//! An event acts only on a key its cache holds, and the refetches one key is
//! asked for inside a window are one refetch
//! (docs/protocol/CACHE-SEMANTICS.md B12–B13b, B19, B20).

use super::browse::{self, BrowseNamespace, WHOLE, invalidate_agents};
use super::gather::{GatherNamespace, ReferencedBy};
use super::match_::{MatchNamespace, ResourceSearch};
use crate::bus::StreamError;
use crate::cache::{Cache, CacheKey, CacheValue};
use crate::channels::{self, Channel};
use crate::client::Links;
use crate::locked;
use crate::refresh::{CacheQuery, Reach, RefreshTrigger, RefreshWhen};
use crate::transport::ConnectionState;
use crate::types::{
    Annotation, AnnotationId, MatchResourcesResponse, ResourceId, StoredEventResponse,
};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::watch;
use tokio::task::{AbortHandle, JoinSet};

// ── Windows ─────────────────────────────────────────────────────────────

/// What a window still owes: the refetch asked for while it was open.
type Owed = Box<dyn FnOnce() + Send>;

struct Window {
    owed: Option<Owed>,
    closing: AbortHandle,
}

/// B19: per key, the first refetch an event asks for runs at once and opens
/// a window; any more inside it are owed, and run as one when it closes,
/// which opens the next. So a storm of events costs a refetch per key per
/// window, and the last event is always reflected.
struct Windows {
    lasting: Duration,
    /// `None` once disposed.
    open: Mutex<Option<HashMap<String, Window>>>,
}

impl Windows {
    fn run(self: &Arc<Self>, key: String, refetch: Owed) {
        let mut open = locked(&self.open);
        let Some(windows) = open.as_mut() else {
            return;
        };
        if let Some(window) = windows.get_mut(&key) {
            window.owed = Some(refetch);
            return;
        }
        let these = Arc::downgrade(self);
        let lasting = self.lasting;
        let of = key.clone();
        let closing = tokio::spawn(async move {
            tokio::time::sleep(lasting).await;
            let Some(these) = these.upgrade() else {
                return;
            };
            let owed = locked(&these.open)
                .as_mut()
                .and_then(|windows| windows.remove(&of))
                .and_then(|window| window.owed);
            if let Some(owed) = owed {
                these.run(of, owed);
            }
        })
        .abort_handle();
        windows.insert(
            key,
            Window {
                owed: None,
                closing,
            },
        );
        drop(open);
        refetch();
    }

    /// Every window closes, and what each owed is dropped.
    fn dispose(&self) {
        if let Some(windows) = locked(&self.open).take() {
            for window in windows.into_values() {
                window.closing.abort();
            }
        }
    }
}

// ── What an event names ─────────────────────────────────────────────────

/// What an event names: which of a split channel's rows it is, the keys a
/// row that reaches its `Subject` acts on, and the value an enriched event
/// carries.
#[derive(Default)]
pub(super) struct Subject {
    pub(super) when: Option<RefreshWhen>,
    pub(super) resource: Option<ResourceId>,
    pub(super) annotation: Option<AnnotationId>,
    pub(super) written: Option<Annotation>,
}

impl Subject {
    fn of(resource: Option<ResourceId>) -> Subject {
        Subject {
            resource,
            ..Subject::default()
        }
    }
}

// ── The refresher ───────────────────────────────────────────────────────

/// See the module's documentation.
pub(crate) struct Refresher {
    browse: Arc<browse::Live>,
    referenced_by: Cache<ResourceId, Vec<ReferencedBy>>,
    searches: Cache<ResourceSearch, MatchResourcesResponse>,
    windows: Arc<Windows>,
    /// What listens for each trigger, until the refresher is disposed.
    listening: Mutex<JoinSet<()>>,
}

impl Refresher {
    /// A refresher of the queries the three namespaces hold, listening from
    /// now on.
    pub(crate) fn new(
        links: &Links,
        browse: &BrowseNamespace,
        gather: &GatherNamespace,
        match_: &MatchNamespace,
    ) -> Arc<Refresher> {
        let refresher = Arc::new(Refresher {
            browse: browse.live.clone(),
            referenced_by: gather.referenced_by.clone(),
            searches: match_.searches.clone(),
            windows: Arc::new(Windows {
                lasting: links.timing.invalidation_window,
                open: Mutex::new(Some(HashMap::new())),
            }),
            listening: Mutex::new(JoinSet::new()),
        });
        refresher.listen(links);
        refresher
    }

    /// Listen for every trigger of the refresh table. Each arm states what
    /// its event names, and a trigger with no arm does not compile.
    fn listen(self: &Arc<Self>, links: &Links) {
        let stored = |event: StoredEventResponse| Subject::of(event.resource_id);
        for trigger in RefreshTrigger::ALL {
            match trigger {
                RefreshTrigger::Reopened => self.on_reopening(links.wire.transport().state()),
                RefreshTrigger::BusResumeGap => {
                    self.on::<channels::BusResumeGap>(links, *trigger, |gap| {
                        Subject::of(ResourceId::new(gap.scope).ok())
                    });
                }
                RefreshTrigger::MarkAdded => {
                    self.on::<channels::MarkAdded>(links, *trigger, |event| {
                        Subject::of(event.resource_id)
                    });
                }
                RefreshTrigger::MarkRemoved => {
                    self.on::<channels::MarkRemoved>(links, *trigger, |event| Subject {
                        annotation: event
                            .payload
                            .get("annotationId")
                            .and_then(|id| id.as_str())
                            .and_then(|id| AnnotationId::new(id).ok()),
                        ..Subject::of(event.resource_id)
                    });
                }
                RefreshTrigger::MarkDeleteOk => {
                    self.on::<channels::MarkDeleteOk>(links, *trigger, |reply| Subject {
                        annotation: Some(reply.response.annotation_id),
                        ..Subject::default()
                    });
                }
                RefreshTrigger::MarkBodyUpdated => {
                    self.on::<channels::MarkBodyUpdated>(links, *trigger, |event| {
                        match event.annotation {
                            Some(annotation) => Subject {
                                when: Some(RefreshWhen::Enriched),
                                resource: event.resource_id,
                                annotation: Some(annotation.id.clone()),
                                written: Some(annotation),
                            },
                            None => Subject {
                                when: Some(RefreshWhen::Unenriched),
                                resource: event.resource_id,
                                annotation: event
                                    .payload
                                    .get("annotationId")
                                    .and_then(|id| id.as_str())
                                    .and_then(|id| AnnotationId::new(id).ok()),
                                written: None,
                            },
                        }
                    });
                }
                RefreshTrigger::MarkEntityTagAdded => {
                    self.on::<channels::MarkEntityTagAdded>(links, *trigger, stored);
                }
                RefreshTrigger::MarkEntityTagRemoved => {
                    self.on::<channels::MarkEntityTagRemoved>(links, *trigger, stored);
                }
                RefreshTrigger::MarkArchived => {
                    self.on::<channels::MarkArchived>(links, *trigger, stored);
                }
                RefreshTrigger::MarkUnarchived => {
                    self.on::<channels::MarkUnarchived>(links, *trigger, stored);
                }
                // What is heard by every client: its resource is the one it
                // records, not a scope the client holds.
                RefreshTrigger::YieldCreated => {
                    self.on::<channels::YieldCreated>(links, *trigger, stored);
                }
                RefreshTrigger::YieldUpdated => {
                    self.on::<channels::YieldUpdated>(links, *trigger, stored);
                }
                RefreshTrigger::YieldCloned => {
                    self.on::<channels::YieldCloned>(links, *trigger, stored);
                }
                RefreshTrigger::YieldMoved => {
                    self.on::<channels::YieldMoved>(links, *trigger, stored);
                }
                RefreshTrigger::FrameEntityTypeAdded => {
                    self.on::<channels::FrameEntityTypeAdded>(links, *trigger, |_| {
                        Subject::default()
                    });
                }
                RefreshTrigger::FrameTagSchemaAdded => {
                    self.on::<channels::FrameTagSchemaAdded>(links, *trigger, |_| {
                        Subject::default()
                    });
                }
            }
        }
    }

    /// Apply `trigger`'s row to what each event on the channel `C` names.
    fn on<C: Channel>(
        self: &Arc<Self>,
        links: &Links,
        trigger: RefreshTrigger,
        names: impl Fn(C::Payload) -> Subject + Send + 'static,
    ) {
        debug_assert_eq!(trigger.channel(), Some(C::NAME));
        let mut events = links.own.stream::<C>();
        let refresher = Arc::downgrade(self);
        locked(&self.listening).spawn(async move {
            while let Some(event) = events.next().await {
                let Some(refresher) = refresher.upgrade() else {
                    return;
                };
                match event {
                    Ok(event) => refresher.refresh(trigger, &names(event.payload)),
                    // An event that was missed, or one that cannot be read:
                    // something changed and nothing says what. Everything
                    // held is asked for again, as after a gap.
                    Err(StreamError::Lagged(_) | StreamError::Undecodable(_)) => {
                        refresher.everything_held();
                    }
                }
            }
        });
    }

    /// B13: the stream is open again having left `Open`, which only a drop
    /// does. A changed subscription is handed over with the state still
    /// `Open`, and misses nothing.
    fn on_reopening(self: &Arc<Self>, mut state: watch::Receiver<ConnectionState>) {
        let refresher = Arc::downgrade(self);
        locked(&self.listening).spawn(async move {
            let (mut opened, mut left) = (false, false);
            loop {
                // A reopening is seen as one because a transport waits on its
                // connection between leaving `Open` and reaching it again,
                // and this task runs in that wait.
                if *state.borrow_and_update() == ConnectionState::Open {
                    if left && let Some(refresher) = refresher.upgrade() {
                        refresher.refresh(RefreshTrigger::Reopened, &Subject::default());
                    }
                    opened = true;
                    left = false;
                } else {
                    left = opened;
                }
                if state.changed().await.is_err() {
                    return;
                }
            }
        });
    }

    fn refresh(&self, trigger: RefreshTrigger, subject: &Subject) {
        let Some(row) = trigger.rows().iter().find(|row| row.when == subject.when) else {
            return;
        };
        // What an event carries, and what it says is gone, is only ever an
        // annotation: the table's own build refuses a row that says more.
        for query in row.writes {
            self.browse.write(*query, subject);
        }
        for query in row.removes {
            self.browse.remove(*query, subject);
        }
        for query in row.refetches {
            self.refetch(*query, subject, row.reach);
        }
    }

    fn everything_held(&self) {
        for query in CacheQuery::ALL {
            self.refetch(*query, &Subject::default(), Reach::Held);
        }
    }

    /// Ask again for one key, when the cache holds it (B20), through the
    /// key's window (B19).
    fn again<K, V>(&self, cache: &Cache<K, V>, key: K, window: String)
    where
        K: CacheKey,
        V: CacheValue,
    {
        if cache.known(&key) {
            let cache = cache.clone();
            self.windows
                .run(window, Box::new(move || cache.invalidate(&key)));
        }
    }

    /// Ask again for every key the cache holds, as one, through one window:
    /// what an event does to a query's answers when it cannot say which of
    /// them it changes.
    fn all_again<K, V>(&self, cache: &Cache<K, V>, window: &str)
    where
        K: CacheKey,
        V: CacheValue,
    {
        let cache = cache.clone();
        self.windows
            .run(window.to_owned(), Box::new(move || cache.invalidate_all()));
    }

    /// B7: ask again, for the keys the row reaches, showing what there is
    /// meanwhile. Each arm names the cache that answers its query, and a
    /// query with no arm does not compile.
    fn refetch(&self, query: CacheQuery, subject: &Subject, reach: Reach) {
        let browse = &self.browse;
        let reached = |held: Vec<ResourceId>| match reach {
            Reach::Held => held,
            Reach::Subject => subject.resource.iter().cloned().collect(),
        };
        match query {
            CacheQuery::Resource => {
                for id in reached(browse.resource.keys()) {
                    let window = format!("resource/{id}");
                    self.again(&browse.resource, id, window);
                }
            }
            CacheQuery::Annotations => {
                for id in reached(browse.annotations.keys()) {
                    let window = format!("annotations/{id}");
                    self.again(&browse.annotations, id, window);
                }
            }
            CacheQuery::Events => {
                for id in reached(browse.events.keys()) {
                    let window = format!("events/{id}");
                    self.again(&browse.events, id, window);
                }
            }
            CacheQuery::ReferencedBy => {
                for id in reached(self.referenced_by.keys()) {
                    let window = format!("referenced-by/{id}");
                    self.again(&self.referenced_by, id, window);
                }
            }
            CacheQuery::Annotation => {
                // The annotation the event names; when it names none, each
                // one held of the resource it names.
                let annotations = match (reach, &subject.annotation) {
                    (Reach::Held, _) => browse.annotation.keys(),
                    (Reach::Subject, Some(annotation)) => vec![annotation.clone()],
                    (Reach::Subject, None) => locked(&browse.annotation_of)
                        .iter()
                        .filter(|(_, of)| Some(*of) == subject.resource.as_ref())
                        .map(|(annotation, _)| annotation.clone())
                        .collect(),
                };
                for id in annotations {
                    let window = format!("annotation/{id}");
                    self.again(&browse.annotation, id, window);
                }
            }
            // An event does not say which lists it changes, nor which
            // searches would now find its resource.
            CacheQuery::Resources => self.all_again(&browse.lists, "resource-lists"),
            CacheQuery::MatchedResources => self.all_again(&self.searches, "matched-resources"),
            CacheQuery::EntityTypes => {
                self.again(
                    &browse.entity_types,
                    WHOLE.to_owned(),
                    "entity-types".to_owned(),
                );
            }
            CacheQuery::TagSchemas => {
                self.again(
                    &browse.tag_schemas,
                    WHOLE.to_owned(),
                    "tag-schemas".to_owned(),
                );
            }
            CacheQuery::Agents => {
                if browse.agents.known(&WHOLE.to_owned()) {
                    let (agents, limits) = (browse.agents.clone(), browse.limits.clone());
                    self.windows.run(
                        "agents".to_owned(),
                        Box::new(move || invalidate_agents(&agents, &limits)),
                    );
                }
            }
        }
    }

    /// Stop: no event refreshes anything after, and what a window owed is
    /// dropped.
    pub(crate) fn dispose(&self) {
        locked(&self.listening).abort_all();
        self.windows.dispose();
    }
}

impl Drop for Refresher {
    fn drop(&mut self) {
        self.dispose();
    }
}
