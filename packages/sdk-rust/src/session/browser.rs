//! What an application holds beside its knowledge bases: the list of the
//! ones it has registered, which of them is active, the active one's session,
//! and what a person has open in each.
//!
//! **One session is live at a time**, the active knowledge base's. Making
//! another active closes it first: its readers see no session, then the new
//! one. Activations do not overlap, and one that was overtaken while it
//! waited does nothing. `session_activating` is true while one is under way,
//! which is what tells "a session is coming" from "there is none".
//!
//! **Look up by address, verify by did.** A sign-in lands on the entry, among
//! those at the address, whose did is the one the knowledge base reported, or
//! on a new entry. The address, the entry a person re-authenticated and the
//! row they clicked say what they believed, and are reported back, never
//! acted on. So an entry's did never changes, and its label and last read are
//! written only from an answer that carried its did.
//!
//! **What is open is per knowledge base**, and shown only while that
//! knowledge base has a live session. When a session comes up, the knowledge
//! base is asked who it is and each open resource is checked against it:
//!
//! - a resource the knowledge base says does not exist is closed; one whose
//!   check failed any other way stays open;
//! - a different knowledge base answering voids what was open and where the
//!   person was, and raises the conflict for a host to show. The entry is
//!   left as it was written;
//! - no answer is no verdict, and changes nothing.
//!
//! A request the gateway refuses for want of a valid token renews the
//! session, and only a session that cannot be renewed is said to have
//! expired. A request refused for lack of permission is said at once.
//!
//! Every change to what is open is made against what the storage holds, as
//! one step, so two contexts that each open a resource both keep theirs.
//!
//! `close` is the graceful end. A browser is built inside a Tokio runtime.

use super::factory::{SessionFactory, SessionFactoryOptions};
use super::knowledge_base::{KbEndpoint, KbRead, KbSessionStatus, KnowledgeBase, NewKnowledgeBase};
use super::open_resource::{OpenResource, TabCheck, apply_tab_checks, sort_open_resources};
use super::semiont_session::SemiontSession;
use super::signals::{KbIdentityConflict, SessionSignals};
use super::stored::{
    ACTIVE_KEY, LAST_VIEWED_RESOURCE_BY_KB_KEY, OPEN_RESOURCES_BY_KB_KEY, StoredSession,
    clear_stored_session, is_token_expired, load_knowledge_bases, save_knowledge_bases,
    store_session, stored_session,
};
use crate::errors::{BusRequestErrorCode, SemiontError, SessionError, TransportErrorCode};
use crate::event_bus::EventBus;
use crate::locked;
use crate::media_types::primary_media_type;
use crate::state::{Held, Tasks};
use crate::storage::{SessionStorage, StorageSubscription};
use crate::transport::{Events, STREAM_BACKLOG};
use crate::types::KbDescription;
use crate::types::ResourceId;
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::{broadcast, watch};
use tokio::task::JoinSet;

/// How many open resources are checked at once when a session comes up: a
/// connection that has just opened is not handed every check together.
const CHECKS_AT_ONCE: usize = 4;

pub struct SemiontBrowserConfig {
    /// Where everything the browser keeps is kept.
    pub storage: Arc<dyn SessionStorage>,
    /// What builds a knowledge base's session.
    pub session_factory: Arc<dyn SessionFactory>,
}

/// What a completed sign-in learned: where it was, who the knowledge base
/// there says it is, the tokens, and what the person believed they were
/// signing in to.
#[derive(Debug, Clone, PartialEq)]
pub struct SignedIn {
    pub endpoint: KbEndpoint,
    /// What the knowledge base said of itself, asked with the new token.
    pub description: KbDescription,
    pub session: StoredSession,
    /// The registered entry the person re-authenticated, when it was one.
    pub kb_id: Option<String>,
    /// The did and the name of a row the person clicked, when it was one.
    pub expected_did: Option<String>,
    pub expected_name: Option<String>,
}

/// What a person believed they were signing in to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Expected {
    pub did: String,
    pub name: Option<String>,
}

/// The entry a sign-in landed on, and what the person believed, so a host
/// can set the two against each other and say when they differ. The sign-in
/// stands either way: the knowledge base that answered is the one reached.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignInOutcome {
    pub kb: KnowledgeBase,
    pub expected: Option<Expected>,
}

/// What a knowledge base said when it was asked to describe itself, read
/// against the entry it was asked as.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KbReadVerdict {
    /// It answered as that entry, and its name and branch are on it now.
    Recorded,
    /// A different knowledge base answered. Its did and the name it gave
    /// itself are here and nowhere else: the entry is as it was.
    Conflict {
        observed_did: String,
        observed_name: String,
    },
    /// It did not answer, or could not say who it is. Evidence of nothing.
    NoVerdict,
}

/// What the browser keeps in memory of what its storage holds.
#[derive(Default)]
struct Kept {
    open_by_kb: HashMap<String, Vec<OpenResource>>,
    last_viewed_by_kb: HashMap<String, ResourceId>,
    /// How many activations are under way or waiting their turn.
    activations: usize,
}

struct Inner {
    storage: Arc<dyn SessionStorage>,
    factory: Arc<dyn SessionFactory>,
    kbs: Held<Vec<KnowledgeBase>>,
    active_kb_id: Held<Option<String>>,
    active_session: Held<Option<Arc<SemiontSession>>>,
    active_signals: Held<Option<Arc<SessionSignals>>>,
    session_activating: Held<bool>,
    open_resources: Held<Vec<OpenResource>>,
    last_viewed_resource: Held<Option<ResourceId>>,
    identity_token: Held<Option<String>>,
    /// `None` once closed.
    errors: Mutex<Option<broadcast::Sender<SessionError>>>,
    bus: EventBus,
    kept: Mutex<Kept>,
    /// One activation at a time.
    turn: tokio::sync::Mutex<()>,
    tasks: Tasks,
    storage_changes: Mutex<Option<StorageSubscription>>,
    closed: AtomicBool,
}

/// See the module's documentation.
pub struct SemiontBrowser {
    inner: Arc<Inner>,
}

fn by_kb<T: serde::de::DeserializeOwned>(stored: Option<&str>) -> HashMap<String, T> {
    stored
        .and_then(|stored| serde_json::from_str(stored).ok())
        .unwrap_or_default()
}

fn milliseconds(at: SystemTime) -> u64 {
    at.duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_millis() as u64)
}

impl SemiontBrowser {
    pub fn new(config: SemiontBrowserConfig) -> SemiontBrowser {
        let storage = config.storage;
        let kbs = load_knowledge_bases(storage.as_ref());
        let active = storage
            .get(ACTIVE_KEY)
            .filter(|stored| kbs.iter().any(|kb| kb.id == *stored))
            .or_else(|| kbs.first().map(|kb| kb.id.clone()));
        let inner = Arc::new(Inner {
            kept: Mutex::new(Kept {
                open_by_kb: by_kb(storage.get(OPEN_RESOURCES_BY_KB_KEY).as_deref()),
                last_viewed_by_kb: by_kb(storage.get(LAST_VIEWED_RESOURCE_BY_KB_KEY).as_deref()),
                ..Kept::default()
            }),
            storage,
            factory: config.session_factory,
            kbs: Held::new(Vec::new()),
            active_kb_id: Held::new(None),
            active_session: Held::new(None),
            active_signals: Held::new(None),
            session_activating: Held::new(false),
            open_resources: Held::new(Vec::new()),
            last_viewed_resource: Held::new(None),
            identity_token: Held::new(None),
            errors: Mutex::new(Some(broadcast::channel(STREAM_BACKLOG).0)),
            bus: EventBus::new(),
            turn: tokio::sync::Mutex::new(()),
            tasks: Tasks::new(),
            storage_changes: Mutex::new(None),
            closed: AtomicBool::new(false),
        });
        // What was read is what is kept: an entry that did not read as a
        // knowledge base is gone from the storage too.
        inner.put_kbs(kbs);
        inner.put_active_id(active.clone());

        let heard = Arc::downgrade(&inner);
        *locked(&inner.storage_changes) = inner.storage.subscribe(Arc::new(move |key, value| {
            if let Some(inner) = heard.upgrade() {
                inner.written_elsewhere(key, value);
            }
        }));

        if let Some(active) = active {
            let starting = inner.clone();
            inner
                .tasks
                .spawn(async move { starting.set_active_kb(Some(active)).await });
        }
        SemiontBrowser { inner }
    }

    // ── What it holds ───────────────────────────────────────────────────

    /// The registered knowledge bases.
    pub fn kbs(&self) -> watch::Receiver<Vec<KnowledgeBase>> {
        self.inner.kbs.read()
    }

    /// The id of the active knowledge base. It names the one meant: its
    /// session may still be on its way, or there may be none.
    pub fn active_kb_id(&self) -> watch::Receiver<Option<String>> {
        self.inner.active_kb_id.read()
    }

    /// The active knowledge base's session, when it has one.
    pub fn active_session(&self) -> watch::Receiver<Option<Arc<SemiontSession>>> {
        self.inner.active_session.read()
    }

    /// What a host shows about the active session. There exactly when the
    /// session is.
    pub fn active_signals(&self) -> watch::Receiver<Option<Arc<SessionSignals>>> {
        self.inner.active_signals.read()
    }

    /// Whether a session is being brought up.
    pub fn session_activating(&self) -> watch::Receiver<bool> {
        self.inner.session_activating.read()
    }

    /// What is open in the active knowledge base, in order. Empty while it
    /// has no live session.
    pub fn open_resources(&self) -> watch::Receiver<Vec<OpenResource>> {
        self.inner.open_resources.read()
    }

    /// The resource last viewed in the active knowledge base. None while it
    /// has no live session, and never another knowledge base's.
    pub fn last_viewed_resource(&self) -> watch::Receiver<Option<ResourceId>> {
        self.inner.last_viewed_resource.read()
    }

    /// The failures that made a session unusable, from now on.
    pub fn errors(&self) -> Events<SessionError> {
        match locked(&self.inner.errors).as_ref() {
            Some(errors) => Events::new(errors.subscribe()),
            None => Events::new(broadcast::channel(1).1),
        }
    }

    /// The token of an identity the host's environment supplies.
    pub fn identity_token(&self) -> watch::Receiver<Option<String>> {
        self.inner.identity_token.read()
    }

    pub fn set_identity_token(&self, token: Option<&str>) {
        self.inner.identity_token.set(token.map(str::to_owned));
    }

    /// Where the browser keeps what it keeps: what a sign-in that is under
    /// way is remembered in, too.
    pub fn storage(&self) -> &Arc<dyn SessionStorage> {
        &self.inner.storage
    }

    /// The application's own bus: what its parts say to each other whether
    /// or not a knowledge base is active. Apart from a client's own bus,
    /// which carries what happens in one knowledge base.
    pub fn bus(&self) -> &EventBus {
        &self.inner.bus
    }

    // ── The knowledge bases ─────────────────────────────────────────────

    /// Register a knowledge base that a sign-in reached, keep its tokens,
    /// and make it the active one.
    pub async fn add_kb(&self, input: NewKnowledgeBase, session: &StoredSession) -> KnowledgeBase {
        self.inner.add_kb(input, session).await
    }

    /// Forget a knowledge base: its entry, its tokens, what was open in it
    /// and where the person was. If it was active, the first of the others
    /// becomes active.
    pub async fn remove_kb(&self, id: &str) {
        let inner = &self.inner;
        clear_stored_session(inner.storage.as_ref(), id);
        inner.forget_kept_of(id);
        let rest: Vec<KnowledgeBase> = inner
            .kbs
            .now()
            .into_iter()
            .filter(|kb| kb.id != id)
            .collect();
        let next = rest.first().map(|kb| kb.id.clone());
        inner.put_kbs(rest);
        if inner.active_kb_id.now().as_deref() == Some(id) {
            inner.set_active_kb(next).await;
        }
    }

    /// Write what a knowledge base last said of itself onto its entry. Its
    /// endpoint is not changed in place, and its did is never changed.
    pub fn update_kb(&self, id: &str, label: Option<&str>, last_read: Option<KbRead>) {
        self.inner.update_kb(id, label, last_read);
    }

    /// What the credential stored for a knowledge base says, read without
    /// asking anyone.
    pub fn kb_session_status(&self, kb_id: &str) -> KbSessionStatus {
        match stored_session(self.inner.storage.as_ref(), kb_id) {
            None => KbSessionStatus::SignedOut,
            Some(stored) if is_token_expired(&stored.access, SystemTime::now()) => {
                KbSessionStatus::Expired
            }
            Some(_) => KbSessionStatus::Authenticated,
        }
    }

    /// Make a knowledge base the active one, or none. Resolves when its
    /// session is up, or when it is known there will be none.
    pub async fn set_active_kb(&self, id: Option<&str>) {
        self.inner.set_active_kb(id.map(str::to_owned)).await;
    }

    /// Keep new tokens for a registered knowledge base and bring its session
    /// up on them. A session it already had is closed and replaced.
    pub async fn sign_in(&self, id: &str, session: &StoredSession) {
        self.inner.sign_in(id, session).await;
    }

    /// The registry's half of a sign-in: land it on the entry for the
    /// knowledge base that answered. See the module's documentation.
    pub async fn signed_in(&self, signed_in: SignedIn) -> SignInOutcome {
        let inner = &self.inner;
        let did = crate::identity::kb_did(&signed_in.description.domain);
        let label = signed_in.description.name.clone();
        let last_read = KbRead::of(&signed_in.description, SystemTime::now());
        let kbs = inner.kbs.now();
        let at_address: Vec<&KnowledgeBase> = kbs
            .iter()
            .filter(|kb| same_place(&kb.endpoint, &signed_in.endpoint))
            .collect();
        // An address with several entries singles out no belief of its own.
        let believed = match &signed_in.kb_id {
            Some(id) => kbs.iter().find(|kb| kb.id == *id),
            None if at_address.len() == 1 => Some(at_address[0]),
            None => None,
        };
        let expected = match (signed_in.expected_did, believed) {
            (Some(did), _) => Some(Expected {
                did,
                name: signed_in.expected_name.filter(|name| !name.is_empty()),
            }),
            (None, Some(believed)) => Some(Expected {
                did: believed.did.clone(),
                name: Some(believed.label.clone()).filter(|label| !label.is_empty()),
            }),
            (None, None) => None,
        };

        let kb = match at_address.iter().find(|kb| kb.did == did) {
            Some(answered) => {
                let id = answered.id.clone();
                let kb = KnowledgeBase {
                    label: label.clone(),
                    last_read: Some(last_read.clone()),
                    ..(*answered).clone()
                };
                inner.update_kb(&id, Some(&label), Some(last_read));
                inner.sign_in(&id, &signed_in.session).await;
                kb
            }
            None => {
                inner
                    .add_kb(
                        NewKnowledgeBase {
                            label,
                            did,
                            endpoint: signed_in.endpoint,
                            last_read: Some(last_read),
                        },
                        &signed_in.session,
                    )
                    .await
            }
        };
        SignInOutcome { kb, expected }
    }

    /// Sign out of a knowledge base: forget its tokens, and have the issuer
    /// told so its refresh token is good for nothing. If it is active, its
    /// session is closed.
    pub async fn sign_out(&self, id: &str) {
        let inner = &self.inner;
        if inner.closed() {
            return;
        }
        let stored = stored_session(inner.storage.as_ref(), id);
        clear_stored_session(inner.storage.as_ref(), id);
        if let Some(stored) = stored {
            // The sign-out is the local act: an issuer that cannot be
            // reached does not keep anyone in a session they asked to end.
            inner.tasks.spawn(inner.factory.revoke(stored));
        }
        // Said again, so whoever shows each knowledge base's status reads it anew.
        inner.kbs.raise(inner.kbs.now());
        if inner.active_kb_id.now().as_deref() == Some(id)
            && let Some(ended) = inner.take_session()
        {
            ended.close().await;
        }
    }

    // ── What is open ────────────────────────────────────────────────────

    /// Open a resource in the active knowledge base, or, when it is open
    /// already, take its name and what else is stated of it.
    pub fn add_open_resource(
        &self,
        id: &ResourceId,
        name: &str,
        media_type: Option<&str>,
        storage_uri: Option<&str>,
    ) {
        self.inner.mutate_open_resources(|mut open| {
            match open.iter_mut().find(|resource| &resource.id == id) {
                Some(resource) => {
                    resource.name = name.to_owned();
                    if let Some(media_type) = media_type {
                        resource.media_type = Some(media_type.to_owned());
                    }
                    if let Some(storage_uri) = storage_uri {
                        resource.storage_uri = Some(storage_uri.to_owned());
                    }
                }
                None => open.push(OpenResource {
                    id: id.clone(),
                    name: name.to_owned(),
                    opened_at: milliseconds(SystemTime::now()),
                    // After the last place taken, not the count: a place
                    // freed by a removal is not handed out twice.
                    order: open
                        .iter()
                        .map(|resource| resource.order + 1)
                        .max()
                        .unwrap_or(0),
                    media_type: media_type.map(str::to_owned),
                    storage_uri: storage_uri.map(str::to_owned),
                }),
            }
            open
        });
    }

    pub fn remove_open_resource(&self, id: &ResourceId) {
        self.inner.mutate_open_resources(|mut open| {
            open.retain(|resource| &resource.id != id);
            open
        });
    }

    pub fn update_open_resource_name(&self, id: &ResourceId, name: &str) {
        self.inner.mutate_open_resources(|mut open| {
            for resource in open.iter_mut().filter(|resource| &resource.id == id) {
                resource.name = name.to_owned();
            }
            open
        });
    }

    /// Move the open resource at one place in the visible list to another.
    /// A place that is not in the list moves nothing.
    pub fn reorder_open_resources(&self, from: usize, to: usize) {
        self.inner.mutate_open_resources(|open| {
            if from >= open.len() || to >= open.len() {
                return open;
            }
            let mut ordered = sort_open_resources(open);
            let moved = ordered.remove(from);
            ordered.insert(to, moved);
            for (place, resource) in ordered.iter_mut().enumerate() {
                resource.order = place as u64;
            }
            ordered
        });
    }

    /// The resource a person is looking at, in the active knowledge base.
    /// Nothing is recorded while it has no live session.
    pub fn set_last_viewed_resource(&self, resource_id: &ResourceId) {
        self.inner.set_last_viewed_resource(resource_id);
    }

    /// Ask the active knowledge base to describe itself again, and say what
    /// it answered. Asking is not activating: an answer as the entry is
    /// recorded on it, and a different knowledge base answering is reported.
    /// Nothing is voided and nothing raised.
    pub async fn read_active_kb(&self) -> KbReadVerdict {
        let inner = &self.inner;
        match (inner.active_session.now(), inner.active_kb_id.now()) {
            (Some(session), Some(kb_id)) => inner.read_kb(&session, &kb_id).await,
            _ => KbReadVerdict::NoVerdict,
        }
    }

    /// End the browser: its session is closed, and everything it holds ends.
    /// Closing twice is closing once.
    pub async fn close(&self) {
        let inner = &self.inner;
        if inner.closed.swap(true, Ordering::SeqCst) {
            return;
        }
        let ended = inner.take_session();
        inner.end();
        if let Some(ended) = ended {
            ended.close().await;
        }
    }
}

impl Drop for SemiontBrowser {
    fn drop(&mut self) {
        self.inner.closed.store(true, Ordering::SeqCst);
        self.inner.end();
    }
}

/// Whether two endpoints are one place: for a gateway, its host and port.
fn same_place(one: &KbEndpoint, other: &KbEndpoint) -> bool {
    match (one, other) {
        (KbEndpoint::Http(one), KbEndpoint::Http(other)) => one.same_address(other),
        (KbEndpoint::Local { kb_id: one }, KbEndpoint::Local { kb_id: other }) => one == other,
        _ => false,
    }
}

/// A live session and what a host shows about it, taken out of the browser
/// to be closed.
struct Ended {
    session: Arc<SemiontSession>,
    signals: Option<Arc<SessionSignals>>,
}

impl Ended {
    async fn close(self) {
        self.session.close().await;
        if let Some(signals) = self.signals {
            crate::state_unit::StateUnit::dispose(signals.as_ref());
        }
    }
}

impl Inner {
    fn closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }

    /// End everything the browser holds. Its session is closed by whoever
    /// took it out first.
    fn end(&self) {
        self.tasks.stop();
        *locked(&self.storage_changes) = None;
        *locked(&self.errors) = None;
        self.kbs.end();
        self.active_kb_id.end();
        self.active_session.end();
        self.active_signals.end();
        self.session_activating.end();
        self.open_resources.end();
        self.last_viewed_resource.end();
        self.identity_token.end();
        self.bus.destroy();
    }

    fn failed(&self, error: SessionError) {
        if let Some(errors) = locked(&self.errors).as_ref() {
            let _ = errors.send(error);
        }
    }

    fn put_kbs(&self, kbs: Vec<KnowledgeBase>) {
        if self.closed() {
            return;
        }
        save_knowledge_bases(self.storage.as_ref(), &kbs);
        self.kbs.raise(kbs);
    }

    fn put_active_id(&self, id: Option<String>) {
        if self.closed() {
            return;
        }
        match &id {
            Some(id) => self.storage.set(ACTIVE_KEY, id),
            None => self.storage.delete(ACTIVE_KEY),
        }
        self.active_kb_id.set(id);
    }

    fn update_kb(&self, id: &str, label: Option<&str>, last_read: Option<KbRead>) {
        let mut kbs = self.kbs.now();
        for kb in kbs.iter_mut().filter(|kb| kb.id == id) {
            if let Some(label) = label {
                kb.label = label.to_owned();
            }
            if let Some(last_read) = &last_read {
                kb.last_read = Some(last_read.clone());
            }
        }
        self.put_kbs(kbs);
    }

    async fn add_kb(
        self: &Arc<Self>,
        input: NewKnowledgeBase,
        session: &StoredSession,
    ) -> KnowledgeBase {
        let kb = KnowledgeBase {
            id: uuid::Uuid::new_v4().to_string(),
            label: input.label,
            did: input.did,
            endpoint: input.endpoint,
            last_read: input.last_read,
        };
        store_session(self.storage.as_ref(), &kb.id, session);
        let mut kbs = self.kbs.now();
        kbs.push(kb.clone());
        self.put_kbs(kbs);
        self.set_active_kb(Some(kb.id.clone())).await;
        kb
    }

    async fn sign_in(self: &Arc<Self>, id: &str, session: &StoredSession) {
        if self.closed() {
            return;
        }
        store_session(self.storage.as_ref(), id, session);
        // A session it already has is on the old tokens: it is closed, and
        // the one built next reads the new ones.
        if self.active_kb_id.now().as_deref() == Some(id)
            && let Some(ended) = self.take_session()
        {
            ended.close().await;
        }
        self.set_active_kb(Some(id.to_owned())).await;
    }

    // ── The active session ──────────────────────────────────────────────

    /// Take the live session out: its readers see none, and what is open is
    /// shown no more. Whoever takes it closes it.
    fn take_session(&self) -> Option<Ended> {
        let session = self.active_session.now()?;
        let signals = self.active_signals.now();
        self.active_session.raise(None);
        self.active_signals.raise(None);
        self.project();
        Some(Ended { session, signals })
    }

    /// The signals first: putting the session is what starts the checks of
    /// it, and a conflict they find is said through the signals. A session
    /// is put once, so what is open is checked once per session.
    fn put_session(self: &Arc<Self>, session: Arc<SemiontSession>, signals: Arc<SessionSignals>) {
        self.active_signals.raise(Some(signals));
        self.active_session.raise(Some(session.clone()));
        self.project();
        let checking = self.clone();
        self.tasks
            .spawn(async move { checking.validate_open_resources(session).await });
    }

    async fn set_active_kb(self: &Arc<Self>, id: Option<String>) {
        if self.closed() {
            return;
        }
        let previous = self.active_kb_id.now();
        if id == previous && self.active_session.now().is_some() {
            return;
        }
        // Said at once: what is meant now is `id`, and no session is live.
        // An activation that waited reads this to learn it was overtaken.
        if previous != id {
            self.put_active_id(id.clone());
        }
        let ended = self.take_session();

        self.activating(1);
        {
            let _turn = self.turn.lock().await;
            if let Some(ended) = ended {
                ended.close().await;
            }
            if !self.closed() && self.active_kb_id.now() == id {
                // One left live by whoever had the turn before.
                if let Some(left) = self.take_session() {
                    left.close().await;
                }
                if let Some(id) = &id {
                    self.activate(id).await;
                }
            }
        }
        self.activating(-1);
    }

    fn activating(&self, change: isize) {
        let mut kept = locked(&self.kept);
        kept.activations = kept.activations.saturating_add_signed(change);
        self.session_activating.set(kept.activations > 0);
    }

    async fn activate(self: &Arc<Self>, id: &str) {
        let Some(kb) = self.kbs.now().into_iter().find(|kb| kb.id == id) else {
            return;
        };
        // The signals exist before the session does: the session says it is
        // over through them, and may be over before it is ready.
        let signals = Arc::new(SessionSignals::new());
        let reporting = Arc::downgrade(self);
        let built = self.factory.session(SessionFactoryOptions {
            kb,
            storage: self.storage.clone(),
            signals: signals.clone(),
            on_error: Arc::new(move |error| {
                if let Some(inner) = reporting.upgrade() {
                    inner.failed(error);
                }
            }),
        });
        let session = match built {
            Ok(session) => Arc::new(session),
            Err(refused) => {
                self.failed(refused);
                return;
            }
        };
        self.tasks.spawn(route(session.clone(), signals.clone()));
        session.ready().await;
        if self.closed() || self.active_kb_id.now().as_deref() != Some(id) {
            Ended {
                session,
                signals: Some(signals),
            }
            .close()
            .await;
            return;
        }
        self.put_session(session, signals);
    }

    // ── What is shown ───────────────────────────────────────────────────

    /// Show what is open, and where the person was, in the active knowledge
    /// base: only while it has a live session.
    fn project(&self) {
        let live = self
            .active_kb_id
            .now()
            .filter(|_| self.active_session.now().is_some());
        let (open, viewed) = {
            let kept = locked(&self.kept);
            match &live {
                Some(kb_id) => (
                    sort_open_resources(kept.open_by_kb.get(kb_id).cloned().unwrap_or_default()),
                    kept.last_viewed_by_kb.get(kb_id).cloned(),
                ),
                None => (Vec::new(), None),
            }
        };
        self.open_resources.set(open);
        self.last_viewed_resource.set(viewed);
    }

    /// The id of the active knowledge base, when it has a live session.
    fn live_kb_id(&self) -> Option<String> {
        self.active_kb_id
            .now()
            .filter(|_| self.active_session.now().is_some())
    }

    /// Change what is open in the active knowledge base, against what the
    /// storage holds, as one step.
    fn mutate_open_resources(&self, mutate: impl Fn(Vec<OpenResource>) -> Vec<OpenResource>) {
        let Some(kb_id) = self.live_kb_id() else {
            return;
        };
        let mut committed = None;
        self.storage
            .update(OPEN_RESOURCES_BY_KB_KEY, &mut |stored| {
                let mut open: HashMap<String, Vec<OpenResource>> = by_kb(stored);
                let list = open.remove(&kb_id).unwrap_or_default();
                open.insert(kb_id.clone(), mutate(list));
                // A map of lists of structs of strings and numbers always serializes.
                let written = serde_json::to_string(&open).unwrap_or_default();
                committed = Some(open);
                Some(written)
            });
        if let Some(open) = committed {
            locked(&self.kept).open_by_kb = open;
        }
        self.project();
    }

    fn set_last_viewed_resource(&self, resource_id: &ResourceId) {
        let Some(kb_id) = self.live_kb_id() else {
            return;
        };
        self.mutate_last_viewed(|viewed| {
            viewed.insert(kb_id.clone(), resource_id.clone());
        });
    }

    fn mutate_last_viewed(&self, mutate: impl Fn(&mut HashMap<String, ResourceId>)) {
        let mut committed = None;
        self.storage
            .update(LAST_VIEWED_RESOURCE_BY_KB_KEY, &mut |stored| {
                let mut viewed: HashMap<String, ResourceId> = by_kb(stored);
                mutate(&mut viewed);
                let written = serde_json::to_string(&viewed).unwrap_or_default();
                committed = Some(viewed);
                Some(written)
            });
        if let Some(viewed) = committed {
            locked(&self.kept).last_viewed_by_kb = viewed;
        }
        self.project();
    }

    /// Forget what was open in a knowledge base and where the person was.
    fn forget_kept_of(&self, kb_id: &str) {
        let mut open = None;
        self.storage
            .update(OPEN_RESOURCES_BY_KB_KEY, &mut |stored| {
                let mut by: HashMap<String, Vec<OpenResource>> = by_kb(stored);
                by.remove(kb_id);
                let written = serde_json::to_string(&by).unwrap_or_default();
                open = Some(by);
                Some(written)
            });
        if let Some(open) = open {
            locked(&self.kept).open_by_kb = open;
        }
        self.mutate_last_viewed(|viewed| {
            viewed.remove(kb_id);
        });
    }

    /// Another context changed what is open, or where the person was.
    fn written_elsewhere(&self, key: &str, value: Option<&str>) {
        if self.closed() {
            return;
        }
        let Some(value) = value else { return };
        match key {
            OPEN_RESOURCES_BY_KB_KEY => {
                if let Ok(open) = serde_json::from_str(value) {
                    locked(&self.kept).open_by_kb = open;
                }
            }
            LAST_VIEWED_RESOURCE_BY_KB_KEY => {
                if let Ok(viewed) = serde_json::from_str(value) {
                    locked(&self.kept).last_viewed_by_kb = viewed;
                }
            }
            _ => return,
        }
        self.project();
    }

    // ── The checks a session's arrival starts ───────────────────────────

    async fn validate_open_resources(self: &Arc<Self>, session: Arc<SemiontSession>) {
        // The session's own knowledge base: by the time this runs, another
        // may be the active one.
        let kb_id = session.kb().id.clone();
        let is_live = |inner: &Inner| {
            !inner.closed()
                && inner
                    .active_session
                    .now()
                    .is_some_and(|live| live.id() == session.id())
        };

        // Who it is, first: if a different knowledge base is answering,
        // every answer about a resource would be an answer to a question
        // asked of the wrong one.
        if let KbReadVerdict::Conflict { observed_did, .. } = self.read_kb(&session, &kb_id).await {
            // The read was of this session's knowledge base: what it voids
            // is the active one's, so only while this is still the active one.
            if is_live(self) {
                self.void_for_conflict(&kb_id, observed_did);
            }
            return;
        }

        // What the storage holds, not what is in memory: another context
        // may have opened a resource before this session came up.
        let ids: VecDeque<ResourceId> =
            by_kb::<Vec<OpenResource>>(self.storage.get(OPEN_RESOURCES_BY_KB_KEY).as_deref())
                .remove(&kb_id)
                .unwrap_or_default()
                .into_iter()
                .map(|resource| resource.id)
                .collect();
        if ids.is_empty() {
            return;
        }
        let waiting = Arc::new(Mutex::new(ids));
        let mut lanes = JoinSet::new();
        for _ in 0..CHECKS_AT_ONCE {
            let (waiting, session) = (waiting.clone(), session.clone());
            lanes.spawn(async move {
                let mut checked = Vec::new();
                loop {
                    let Some(id) = locked(&waiting).pop_front() else {
                        return checked;
                    };
                    let check = check_open_resource(&session, &id).await;
                    checked.push((id, check));
                }
            });
        }
        let mut checks = HashMap::new();
        while let Some(lane) = lanes.join_next().await {
            checks.extend(lane.unwrap_or_default());
        }
        if is_live(self) {
            self.mutate_open_resources(|open| apply_tab_checks(open, &checks));
        }
    }

    /// Ask the knowledge base to describe itself, against the entry it is
    /// asked as. If it is the one the entry says, its name and branch are
    /// recorded on the entry. Otherwise nothing is recorded.
    ///
    /// A did is read one way only. It is not unique, so one that differs
    /// says a different knowledge base answered, and one that matches says
    /// nothing about what is in it: that is each resource's own check.
    async fn read_kb(&self, session: &SemiontSession, kb_id: &str) -> KbReadVerdict {
        let Some(expected_did) = self
            .kbs
            .now()
            .into_iter()
            .find(|kb| kb.id == kb_id)
            .map(|kb| kb.did)
        else {
            return KbReadVerdict::NoVerdict;
        };
        let Ok(description) = session.client().browse.kb().await else {
            return KbReadVerdict::NoVerdict;
        };
        let observed_did = crate::identity::kb_did(&description.domain);
        if observed_did != expected_did {
            return KbReadVerdict::Conflict {
                observed_did,
                observed_name: description.name,
            };
        }
        if self.closed() {
            return KbReadVerdict::NoVerdict;
        }
        self.update_kb(
            kb_id,
            Some(&description.name),
            Some(KbRead::of(&description, SystemTime::now())),
        );
        KbReadVerdict::Recorded
    }

    /// What an activation does when a different knowledge base answered for
    /// the active entry: void what claims to be about the entry's contents,
    /// both at once, and raise the conflict. Registering the knowledge base
    /// that answered is a person's act.
    fn void_for_conflict(&self, kb_id: &str, observed_did: String) {
        let Some(expected_did) = self
            .kbs
            .now()
            .into_iter()
            .find(|kb| kb.id == kb_id)
            .map(|kb| kb.did)
        else {
            return;
        };
        self.mutate_open_resources(|_| Vec::new());
        self.mutate_last_viewed(|viewed| {
            viewed.remove(kb_id);
        });
        if let Some(signals) = self.active_signals.now() {
            signals.notify_kb_identity_conflict(KbIdentityConflict {
                expected_did,
                observed_did,
            });
        }
    }
}

/// One open resource's verdict. Asking for it freshly also puts what it
/// answered in the client's cache, where a viewer reads it.
async fn check_open_resource(session: &SemiontSession, id: &ResourceId) -> TabCheck {
    match session.client().browse.resource(id).fresh().await {
        Ok(descriptor) => TabCheck::Ready {
            media_type: primary_media_type(&descriptor).map(str::to_owned),
            name: descriptor.name,
        },
        Err(SemiontError::Bus(answer)) if answer.code == BusRequestErrorCode::NotFound => {
            TabCheck::Gone
        }
        // Anything else is a symptom, not a verdict.
        Err(_) => TabCheck::Unknown,
    }
}

/// Route what the session's transport fails at. A refusal for want of a
/// valid token renews the session: it heals quietly, or the session ends
/// itself and says so once. A refusal for lack of permission has no remedy,
/// and is said. Ends when the transport closes.
async fn route(session: Arc<SemiontSession>, signals: Arc<SessionSignals>) {
    let mut failures = session.errors();
    let mut renewing = JoinSet::new();
    while let Some(failure) = failures.next().await {
        // A failure that was missed is not known, and is not acted on.
        let Ok(failure) = failure else { continue };
        while renewing.try_join_next().is_some() {}
        match failure.code {
            TransportErrorCode::Unauthorized => {
                let session = session.clone();
                renewing.spawn(async move {
                    session.refresh().await;
                });
            }
            TransportErrorCode::Forbidden => {
                signals.notify_permission_denied(Some(&failure.message));
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    //! What the checks of a session do once it is no longer the live one.
    //! A session is put and replaced by tasks that do not wait for each
    //! other, so its checks can end after another session took its place.
    //! No order of calls from outside makes that happen on one thread, so
    //! these call the checks themselves.

    use super::*;
    use crate::identity::kb_did;
    use crate::session::{HttpEndpoint, Protocol};
    use crate::testing::{ScriptedSessions, SharedStorage};
    use serde_json::{Value, json};
    use std::collections::HashSet;
    use std::time::Duration;

    const A: &str = "kb-a";
    const B: &str = "kb-b";

    /// What a knowledge base's gateway says: who it is, and which resources
    /// it does not have.
    struct Says {
        description: Value,
        gone: HashSet<String>,
    }

    /// Scripted sessions of knowledge bases that say what the test told
    /// them to, and every request one answered: the knowledge base's id
    /// and the operation.
    struct Gateways {
        sessions: ScriptedSessions,
        said: Arc<Mutex<HashMap<String, Says>>>,
        answered: Arc<Mutex<Vec<(String, String)>>>,
    }

    fn asked_about(payload: &serde_json::Map<String, Value>) -> String {
        payload
            .get("resourceId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned()
    }

    impl Gateways {
        fn new() -> Gateways {
            let said: Arc<Mutex<HashMap<String, Says>>> = Arc::default();
            let answered: Arc<Mutex<Vec<(String, String)>>> = Arc::default();
            let (answering, refusing, recording) = (said.clone(), said.clone(), answered.clone());
            let sessions = ScriptedSessions::answering(move |kb_id, operation, payload| {
                locked(&recording).push((kb_id.to_owned(), operation.to_owned()));
                match operation {
                    "browse:kb-requested" => locked(&answering)
                        .get(kb_id)
                        .map(|says| Some(says.description.clone()))
                        .ok_or_else(|| "the knowledge base does not answer".to_owned()),
                    "browse:resource-requested" => {
                        let id = asked_about(payload);
                        Ok(Some(json!({
                            "resource": {
                                "@context": "https://schema.org", "@id": id,
                                "name": format!("name-{id}"), "representations": [],
                            },
                            "annotations": [], "entityReferences": [],
                        })))
                    }
                    other => Err(format!("{other} is not answered here")),
                }
            });
            sessions.refuse_when(move |kb_id, operation, payload| {
                let gone = locked(&refusing)
                    .get(kb_id)
                    .is_some_and(|says| says.gone.contains(&asked_about(payload)));
                (operation == "browse:resource-requested" && gone)
                    .then(|| json!({ "code": "not-found", "message": "no such resource" }))
            });
            Gateways {
                sessions,
                said,
                answered,
            }
        }

        fn says(&self, kb_id: &str, description: Value, gone: &[&str]) {
            let gone = gone.iter().map(|id| (*id).to_owned()).collect();
            locked(&self.said).insert(kb_id.to_owned(), Says { description, gone });
        }
    }

    fn entry(id: &str, domain: &str, port: u16) -> KnowledgeBase {
        KnowledgeBase {
            id: id.to_owned(),
            label: id.to_owned(),
            did: kb_did(domain),
            endpoint: KbEndpoint::Http(HttpEndpoint {
                host: "localhost".to_owned(),
                port,
                protocol: Protocol::Http,
            }),
            last_read: None,
        }
    }

    /// A browser whose live session is B's, with `r1` open and last viewed
    /// in both knowledge bases; and a session of A that is not the live one.
    async fn replaced(
        gateways: &Gateways,
        kbs: [KnowledgeBase; 2],
    ) -> (SemiontBrowser, Arc<SemiontSession>) {
        let storage = Arc::new(SharedStorage::new());
        save_knowledge_bases(storage.as_ref(), &kbs);
        storage.set(ACTIVE_KEY, B);
        let opened = json!([{ "id": "r1", "name": "R1", "openedAt": 1, "order": 0 }]);
        storage.set(
            OPEN_RESOURCES_BY_KB_KEY,
            &json!({ A: opened, B: opened }).to_string(),
        );
        storage.set(
            LAST_VIEWED_RESOURCE_BY_KB_KEY,
            &json!({ A: "r1", B: "r1" }).to_string(),
        );
        let browser = SemiontBrowser::new(SemiontBrowserConfig {
            storage: storage.clone(),
            session_factory: Arc::new(gateways.sessions.clone()),
        });
        let mut live = browser.active_session();
        tokio::time::timeout(Duration::from_secs(60), live.wait_for(Option::is_some))
            .await
            .expect("a session comes up")
            .expect("the browser lives");
        // The live session's own checks run.
        tokio::time::sleep(Duration::from_millis(1)).await;

        let [of_a, _] = kbs;
        let stale = gateways
            .sessions
            .session(SessionFactoryOptions {
                kb: of_a,
                storage,
                signals: Arc::new(SessionSignals::new()),
                on_error: Arc::new(|_| {}),
            })
            .expect("a session");
        stale.ready().await;
        (browser, Arc::new(stale))
    }

    fn shown(browser: &SemiontBrowser) -> (Vec<String>, Option<String>) {
        (
            browser
                .open_resources()
                .borrow()
                .iter()
                .map(|resource| resource.id.to_string())
                .collect(),
            browser
                .last_viewed_resource()
                .borrow()
                .as_deref()
                .map(str::to_owned),
        )
    }

    #[tokio::test(start_paused = true)]
    async fn the_checks_of_a_replaced_session_are_of_its_own_knowledge_base_and_change_nothing_shown()
     {
        // One knowledge base in two places: one did, and each entry its own.
        let gateways = Gateways::new();
        let at = |name: &str, branch: &str| json!({ "name": name, "domain": "example.org", "gitBranch": branch });
        gateways.says(A, at("At A", "branch-a"), &["r1"]);
        gateways.says(B, at("At B", "branch-b"), &[]);
        let kbs = [entry(A, "example.org", 4000), entry(B, "example.org", 4001)];
        let (browser, stale) = replaced(&gateways, kbs).await;

        browser.inner.validate_open_resources(stale).await;

        let said = |id: &str| {
            let kbs = browser.kbs().borrow().clone();
            let kb = kbs.into_iter().find(|kb| kb.id == id).expect("an entry");
            (kb.label, kb.last_read.and_then(|read| read.git_branch))
        };
        // What it said of itself is on its own entry, and not on the entry
        // of the knowledge base that is active.
        assert_eq!(said(A), ("At A".to_owned(), Some("branch-a".to_owned())));
        assert_eq!(said(B), ("At B".to_owned(), Some("branch-b".to_owned())));
        // It says `r1` is gone. That is not said of what is open now.
        assert_eq!(
            shown(&browser),
            (vec!["r1".to_owned()], Some("r1".to_owned()))
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_conflict_a_replaced_session_finds_voids_nothing_and_is_not_raised() {
        let gateways = Gateways::new();
        gateways.says(
            A,
            json!({ "name": "Another", "domain": "elsewhere.example" }),
            &[],
        );
        gateways.says(B, json!({ "name": "At B", "domain": "b.example" }), &[]);
        let kbs = [entry(A, "a.example", 4000), entry(B, "b.example", 4001)];
        let (browser, stale) = replaced(&gateways, kbs).await;

        browser.inner.validate_open_resources(stale).await;

        // A knowledge base that turned out to be another is asked who it is
        // and nothing of any resource.
        let of_a: Vec<String> = locked(&gateways.answered)
            .iter()
            .filter(|(kb_id, _)| kb_id == A)
            .map(|(_, operation)| operation.clone())
            .collect();
        assert_eq!(of_a, ["browse:kb-requested"]);
        assert_eq!(
            shown(&browser),
            (vec!["r1".to_owned()], Some("r1".to_owned()))
        );
        let signals = browser.active_signals().borrow().clone().expect("signals");
        assert_eq!(*signals.kb_identity_conflict().borrow(), None);
        // Nor is where the person was in it forgotten.
        let viewed: HashMap<String, String> = by_kb(
            browser
                .storage()
                .get(LAST_VIEWED_RESOURCE_BY_KB_KEY)
                .as_deref(),
        );
        assert_eq!(viewed.get(A).map(String::as_str), Some("r1"));
    }
}
