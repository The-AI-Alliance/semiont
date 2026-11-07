//! What keeps a client's queries true: protocol/specs/src/client/refresh.json
//! (`crate::refresh`), applied to the caches of the namespaces that hold
//! queries. Each event on the bus, and the reopening of a dropped stream,
//! asks again for the queries its row names, writes the ones whose new value
//! the event carries, and ends the ones whose entity is gone.
//!
//! A client has one refresher. What each event names (its resource, its
//! annotation, the value it carries) it reads where the table's row says it
//! is. It states for itself only which namespace's cache answers each query
//! of the table: `gather` what refers to a resource, `match_` the searches,
//! `browse` the rest; a match over the table's own enum, so a query added to
//! the table does not compile until it is answered here.
//!
//! An event acts only on a key its cache holds, and the refetches one key is
//! asked for inside a window are one refetch
//! (protocol/contract/CACHE-SEMANTICS.md B12–B13b, B19, B20).
//!
//! The refresher is also where a frame's place is noted, in the stream's
//! places coupled to the client (`crate::resume`): only once it has taken
//! the frame's event in, so a place is never noted while the refetch its
//! event asks for is neither owed nor in flight (B17).

use super::browse::{self, BrowseNamespace, WholeKey, invalidate_engines};
use super::gather::{GatherNamespace, ReferencedBy};
use super::match_::{MatchNamespace, ResourceSearch};
use crate::bus::held_to;
use crate::cache::{Cache, CacheKey, CacheValue};
use crate::channels::RESOURCE_SCOPED_CHANNELS;
use crate::client::Links;
use crate::locked;
use crate::refresh::{CacheQuery, CacheRefresh, Reach, RefreshTrigger, RefreshWhen};
use crate::resume::CoupledBookmarks;
use crate::transport::{ConnectionState, Frame, FrameRefusal, Lagged};
use crate::types::{Annotation, AnnotationId, MatchResourcesResponse, ResourceId};
use serde::Deserialize;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
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
///
/// A refetch is started under the lock of the windows, so whoever reads
/// what is owed (`owes`) waits until a refetch a closing window gave up has
/// started, and is never told that nothing is owed while it is neither
/// owed nor in flight (B17). Starting a refetch only marks its key and
/// spawns its fetch: it reads no window, and writes nothing.
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
        match windows.get_mut(&key) {
            Some(window) => window.owed = Some(refetch),
            None => self.open_window(windows, key, refetch),
        }
    }

    /// Open `key`'s window, and start `refetch`, with `windows` locked.
    fn open_window(
        self: &Arc<Self>,
        windows: &mut HashMap<String, Window>,
        key: String,
        refetch: Owed,
    ) {
        let these = Arc::downgrade(self);
        let lasting = self.lasting;
        let of = key.clone();
        let closing = tokio::spawn(async move {
            tokio::time::sleep(lasting).await;
            if let Some(these) = these.upgrade() {
                these.close(&of);
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
        refetch();
    }

    /// `key`'s window closes: what it owed starts at once, and opens the
    /// next window, under the one lock.
    fn close(self: &Arc<Self>, key: &str) {
        let mut open = locked(&self.open);
        let Some(windows) = open.as_mut() else {
            return;
        };
        if let Some(owed) = windows.remove(key).and_then(|window| window.owed) {
            self.open_window(windows, key.to_owned(), owed);
        }
    }

    /// Whether a window holds a refetch it has not yet run.
    fn owes(&self) -> bool {
        locked(&self.open)
            .as_ref()
            .is_some_and(|windows| windows.values().any(|window| window.owed.is_some()))
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

/// An event that cannot be read: missed, refused, or one a member of which
/// its row names is present and is not what the row names.
struct Unreadable;

/// The member `way` ends at in `event`: none where the row names no way, or
/// where the member, or one it passes through, is absent or null. One it
/// passes through that is present and is no object makes the event
/// unreadable.
fn member_at<'a>(event: &'a Value, way: Option<&[&str]>) -> Result<Option<&'a Value>, Unreadable> {
    let Some(way) = way else {
        return Ok(None);
    };
    let mut member = event;
    for name in way {
        member = match member {
            Value::Null => return Ok(None),
            Value::Object(members) => match members.get(*name) {
                Some(within) => within,
                None => return Ok(None),
            },
            _ => return Err(Unreadable),
        };
    }
    Ok(match member {
        Value::Null => None,
        present => Some(present),
    })
}

/// What `way` names in `event`, read as a `T` by its own decoder (an id's
/// decoder holds its pattern): one present and not a `T` makes the event
/// unreadable.
fn named<'a, T: Deserialize<'a>>(
    event: &'a Value,
    way: Option<&[&str]>,
) -> Result<Option<T>, Unreadable> {
    match member_at(event, way)? {
        None => Ok(None),
        Some(member) => T::deserialize(member).map(Some).map_err(|_| Unreadable),
    }
}

/// `trigger`'s row for events `when` says they are. The table's own reader
/// refuses a trigger that has not exactly one.
fn row(trigger: RefreshTrigger, when: Option<RefreshWhen>) -> &'static CacheRefresh {
    match trigger.rows().iter().find(|row| row.when == when) {
        Some(row) => row,
        None => panic!("the refresh table has no row for {trigger:?} when {when:?}"),
    }
}

/// The trigger of the events of `channel`, when the table names it.
fn trigger_of(channel: &str) -> Option<RefreshTrigger> {
    RefreshTrigger::ALL
        .iter()
        .find(|trigger| trigger.channel() == Some(channel))
        .copied()
}

/// What a frame of `trigger` names, by the ways of its row. A split
/// channel's event is enriched when the member its enriched row carries is
/// present.
fn subject(trigger: RefreshTrigger, frame: Frame) -> Result<Subject, Unreadable> {
    let event = held_to(&frame.channel, frame.payload).map_err(|_| Unreadable)?;
    let enriched = trigger
        .rows()
        .iter()
        .find(|row| row.when == Some(RefreshWhen::Enriched));
    let when = match enriched {
        None => None,
        Some(enriched) => match member_at(&event, enriched.carries)? {
            Some(_) => Some(RefreshWhen::Enriched),
            None => Some(RefreshWhen::Unenriched),
        },
    };
    let row = row(trigger, when);
    Ok(Subject {
        when,
        resource: named(&event, row.names.resource)?,
        annotation: named(&event, row.names.annotation)?,
        written: named(&event, row.carries)?,
    })
}

// ── The refresher ───────────────────────────────────────────────────────

/// See the module's documentation.
pub(crate) struct Refresher {
    browse: Arc<browse::Live>,
    referenced_by: Cache<ResourceId, Vec<ReferencedBy>>,
    matched_resources: Cache<ResourceSearch, MatchResourcesResponse>,
    windows: Arc<Windows>,
    /// The stream's places of the client, once they are coupled to it
    /// (`crate::resume::CoupledBookmarks::couple_to`): the place a frame
    /// brings its scope to is noted there once its event has been taken in.
    places: OnceLock<CoupledBookmarks>,
    /// What listens for the stream's reopening and for the events, until the
    /// refresher is disposed.
    listening: Mutex<JoinSet<()>>,
}

/// The channels whose frames the refresher reads: each one the table names,
/// and each one a resource's scope carries, whose frames bring their scope
/// to a place whether or not the table names their channel.
fn heard_channels() -> Vec<&'static str> {
    let mut channels: Vec<&'static str> = RefreshTrigger::ALL
        .iter()
        .filter_map(|trigger| trigger.channel())
        .collect();
    for channel in RESOURCE_SCOPED_CHANNELS {
        if !channels.contains(channel) {
            channels.push(channel);
        }
    }
    channels
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
            matched_resources: match_.matched_resources.clone(),
            windows: Arc::new(Windows {
                lasting: links.timing.invalidation_window,
                open: Mutex::new(Some(HashMap::new())),
            }),
            places: OnceLock::new(),
            listening: Mutex::new(JoinSet::new()),
        });
        refresher.listen(links);
        refresher
    }

    /// Listen for every trigger of the refresh table: the stream's reopening,
    /// and the events of the channels it reads (`heard_channels`), in the
    /// order they were published, so the places they bring their scopes to
    /// are noted in that order too.
    fn listen(self: &Arc<Self>, links: &Links) {
        self.on_reopening(links.transport.state());
        let mut frames = links.own.frames_among(&heard_channels());
        let refresher = Arc::downgrade(self);
        locked(&self.listening).spawn(async move {
            while let Some(heard) = frames.next().await {
                let Some(refresher) = refresher.upgrade() else {
                    return;
                };
                refresher.heard(heard);
            }
        });
    }

    /// Apply the row of a frame's channel to what its event names; to one
    /// that cannot be read, the row of an unreadable event. A missed event
    /// is one: something changed and nothing says what. Then the place the
    /// frame brings its scope to is noted, its event taken in: the fetch it
    /// started is in flight, or the refetch it asked for is owed (B17). A
    /// refusal on a channel the table does not name changes nothing held.
    fn heard(&self, heard: Result<Result<Frame, FrameRefusal>, Lagged>) {
        let frame = match heard {
            Ok(Ok(frame)) => frame,
            Ok(Err(refusal)) => {
                if trigger_of(&refusal.channel).is_some() {
                    self.refresh(RefreshTrigger::Unreadable, &Subject::default());
                }
                return;
            }
            Err(Lagged(_)) => {
                self.refresh(RefreshTrigger::Unreadable, &Subject::default());
                return;
            }
        };
        let stream_id = frame.stream_id.clone();
        if let Some(trigger) = trigger_of(&frame.channel) {
            match subject(trigger, frame) {
                Ok(subject) => self.refresh(trigger, &subject),
                Err(Unreadable) => {
                    self.refresh(RefreshTrigger::Unreadable, &Subject::default());
                }
            }
        }
        if let (Some(at), Some(places)) = (stream_id, self.places.get()) {
            places.save(&at.scope, &at.event_id);
        }
    }

    /// Note the places of each frame taken in from now on in `places`. A
    /// refresher whose places are coupled already keeps them.
    pub(crate) fn couple(&self, places: CoupledBookmarks) {
        let _ = self.places.set(places);
    }

    /// The places coupled to the client, once they are.
    pub(crate) fn places(&self) -> Option<&CoupledBookmarks> {
        self.places.get()
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
        let row = row(trigger, subject.when);
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
                    let window = format!("{}/{id}", query.name());
                    self.again(&browse.resource, id, window);
                }
            }
            CacheQuery::Annotations => {
                for id in reached(browse.annotations.keys()) {
                    let window = format!("{}/{id}", query.name());
                    self.again(&browse.annotations, id, window);
                }
            }
            CacheQuery::Events => {
                for id in reached(browse.events.keys()) {
                    let window = format!("{}/{id}", query.name());
                    self.again(&browse.events, id, window);
                }
            }
            CacheQuery::ReferencedBy => {
                for id in reached(self.referenced_by.keys()) {
                    let window = format!("{}/{id}", query.name());
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
                    let window = format!("{}/{id}", query.name());
                    self.again(&browse.annotation, id, window);
                }
            }
            // An event does not say which lists it changes, nor which
            // searches would now find its resource.
            CacheQuery::Resources => self.all_again(&browse.resources, query.name()),
            CacheQuery::MatchedResources => self.all_again(&self.matched_resources, query.name()),
            CacheQuery::EntityTypes => {
                self.again(&browse.entity_types, WholeKey, query.name().to_owned());
            }
            CacheQuery::TagSchemas => {
                self.again(&browse.tag_schemas, WholeKey, query.name().to_owned());
            }
            CacheQuery::Engines => {
                if browse.engines.known(&WholeKey) {
                    let (engines, limits) = (browse.engines.clone(), browse.limits.clone());
                    self.windows.run(
                        query.name().to_owned(),
                        Box::new(move || invalidate_engines(&engines, &limits)),
                    );
                }
            }
        }
    }

    /// Whether a refetch an event asked for is owed: a window (B19) holds
    /// one it has not yet run.
    pub(crate) fn owes_a_refetch(&self) -> bool {
        self.windows.owes()
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    /// The last part of a path: `ResourceDescriptor` of
    /// `semiont::types::ResourceDescriptor`.
    fn last_part(path: &str) -> &str {
        path.rsplit_once("::").map_or(path, |(_, last)| last)
    }

    /// A type's name with every path in it dropped:
    /// `Vec<AttributedEvent>`.
    fn unpathed(name: &str) -> String {
        let mut unpathed = String::new();
        let mut path = String::new();
        for c in name.chars() {
            if c.is_alphanumeric() || c == '_' || c == ':' {
                path.push(c);
            } else {
                unpathed.push_str(last_part(&path));
                path.clear();
                unpathed.push(c);
            }
        }
        unpathed.push_str(last_part(&path));
        unpathed
    }

    /// The name of what the cache `of` reaches holds for a key.
    fn held<S, K: CacheKey, V: CacheValue>(_of: for<'a> fn(&'a S) -> &'a Cache<K, V>) -> String {
        unpathed(std::any::type_name::<V>())
    }

    /// What the cache that answers `query` holds for a key, by its Rust
    /// type's name: the cache each arm of `Refresher::refetch` names.
    fn value_of(query: CacheQuery) -> String {
        match query {
            CacheQuery::Resource => held::<browse::Live, _, _>(|live| &live.resource),
            CacheQuery::Annotations => held::<browse::Live, _, _>(|live| &live.annotations),
            CacheQuery::Annotation => held::<browse::Live, _, _>(|live| &live.annotation),
            CacheQuery::Events => held::<browse::Live, _, _>(|live| &live.events),
            CacheQuery::ReferencedBy => {
                held::<Refresher, _, _>(|refresher| &refresher.referenced_by)
            }
            CacheQuery::Resources => held::<browse::Live, _, _>(|live| &live.resources),
            CacheQuery::MatchedResources => {
                held::<Refresher, _, _>(|refresher| &refresher.matched_resources)
            }
            CacheQuery::EntityTypes => held::<browse::Live, _, _>(|live| &live.entity_types),
            CacheQuery::TagSchemas => held::<browse::Live, _, _>(|live| &live.tag_schemas),
            CacheQuery::Engines => held::<browse::Live, _, _>(|live| &live.engines),
        }
    }

    /// The Rust type `schema`, read in the directory `within`, is held as,
    /// by name: a component by its name, an array as a `Vec` of its items,
    /// text as a `String`.
    fn named_by(schema: &Value, within: &Path) -> String {
        if let Some(reference) = schema["$ref"].as_str() {
            return referenced(reference, within);
        }
        match schema["type"].as_str() {
            Some("array") => format!("Vec<{}>", named_by(&schema["items"], within)),
            Some("string") => "String".to_owned(),
            other => {
                panic!("a schema of type {other:?}, which this census does not read: {schema}")
            }
        }
    }

    /// The Rust type `reference`, a `$ref` from a schema in `within`, names:
    /// the component its file is, or the member of it its pointer names.
    fn referenced(reference: &str, within: &Path) -> String {
        let (file, pointer) = match reference.split_once('#') {
            Some((file, pointer)) => (file, Some(pointer)),
            None => (reference, None),
        };
        let path = within.join(file);
        let Some(pointer) = pointer else {
            return path
                .file_stem()
                .and_then(|stem| stem.to_str())
                .unwrap_or_else(|| panic!("{reference} names no component"))
                .to_owned();
        };
        let text = std::fs::read_to_string(&path)
            .unwrap_or_else(|unread| panic!("{}: {unread}", path.display()));
        let component: Value = serde_json::from_str(&text)
            .unwrap_or_else(|refused| panic!("{}: {refused}", path.display()));
        let member = component
            .pointer(pointer)
            .unwrap_or_else(|| panic!("{reference} names no member"));
        let directory = path
            .parent()
            .unwrap_or_else(|| panic!("{} is in no directory", path.display()));
        named_by(member, directory)
    }

    /// client/refresh.json's `value` owns what each query's cache holds: the
    /// cache that answers each query holds the type its `value` names. A
    /// query the table gains fails here, as `value_of` does not compile
    /// until it names the query's cache; a value that names another
    /// component, or another member, than the type the cache holds fails
    /// here too.
    #[test]
    fn each_querys_cache_holds_what_its_value_in_the_refresh_table_names() {
        let table: Value = serde_json::from_str(include_str!("../../specs/client/refresh.json"))
            .expect("the refresh table is JSON");
        let within = Path::new(env!("CARGO_MANIFEST_DIR")).join("specs/client");
        let rows = table["queries"]
            .as_array()
            .expect("the refresh table has queries");
        let named: Vec<&str> = rows
            .iter()
            .map(|row| row["name"].as_str().expect("a query has a name"))
            .collect();
        let ours: Vec<&str> = CacheQuery::ALL.iter().map(|query| query.name()).collect();
        assert_eq!(ours, named, "the queries");

        let mut wrong = Vec::new();
        for (row, query) in rows.iter().zip(CacheQuery::ALL) {
            let value = named_by(&row["value"], &within);
            let cached = value_of(*query);
            if cached != value {
                wrong.push(format!(
                    "{}'s cache holds {cached}, and its value is {value}",
                    query.name()
                ));
            }
        }
        assert!(wrong.is_empty(), "{}", wrong.join("\n"));
    }

    /// A refetch a closing window runs is owed until its fetch is in flight
    /// (B17): from the window giving it up until the refetch has started,
    /// whoever reads what is owed (a kept cache's write reading the gate, a
    /// client's close) is told it is owed, or waits until it has started.
    /// The refetch here reads it as it starts.
    #[tokio::test(start_paused = true)]
    async fn a_refetch_a_closing_window_runs_is_owed_until_it_has_started() {
        let lasting = Duration::from_millis(100);
        let windows = Arc::new(Windows {
            lasting,
            open: Mutex::new(Some(HashMap::new())),
        });
        windows.run("annotations/res-1".to_owned(), Box::new(|| {}));
        let told: Arc<Mutex<Option<bool>>> = Arc::default();
        let (reading, telling) = (Arc::downgrade(&windows), told.clone());
        windows.run(
            "annotations/res-1".to_owned(),
            Box::new(move || {
                let windows = reading
                    .upgrade()
                    .expect("the windows outlive the refetch they run");
                // Held while the refetch starts, the lock keeps a reader
                // waiting until it has.
                let free = windows.open.try_lock().is_ok();
                *locked(&telling) = Some(!free || windows.owes());
            }),
        );
        assert!(windows.owes(), "the open window owes the second refetch");

        tokio::time::sleep(lasting * 2).await;
        assert_eq!(
            *locked(&told),
            Some(true),
            "the refetch the closing window ran was not owed as it started"
        );
    }
}
