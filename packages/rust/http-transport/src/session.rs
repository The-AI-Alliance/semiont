//! Sessions with a knowledge base over its gateway: what builds one
//! (`HttpSessionFactory`, for a registry of knowledge bases, and
//! `session_from_kept`, which a script uses directly and which gives an
//! `OpenedSession`: the session and the client it was built with, which the
//! script closes together), a script's sign-in and sign-out of a sign-in it
//! keeps (`sign_in_device`, `sign_out`), what a completed sign-in learns of
//! the knowledge base it reached, and a registry's sign-in through the
//! issuer.
//!
//! A session built here renews its token at the issuer its kept sign-in
//! names. Renewals of one knowledge base that are asked for together are one
//! request: several requests refused at once ask for one new token.
//!
//! A person's token is one credential source. An agent's is another
//! (`crate::agent`), which feeds a transport the same way.

use crate::content::HttpContentTransport;
use crate::oauth::{
    BeginAuthorization, DeviceCode, begin_authorization, complete_authorization, renew_kept,
    revoke_at_issuer, sign_in_with_device_grant,
};
use crate::transport::{HttpTransport, HttpTransportConfig, Timing, TokenRefresher, locked};
use futures::FutureExt;
use futures::future::Shared;
use rand_core::Rng;
use semiont::bus::reply_channels_for;
use semiont::channels::{BrowseKbRequested, Channel};
use semiont::client::{CachePersistence, ClientOptions, SemiontClient};
use semiont::errors::{
    BusRequestErrorCode, IdentityUnverifiable, IdentityUnverifiableReason, SemiontError,
    SessionError, SessionErrorCode, SignInError, SignInErrorCode,
};
use semiont::resume::CoupledBookmarks;
use semiont::session::{
    BROWSER_CLIENT_ID, OnAuthFailed, OnSessionError, OpenedSession, Refresh, SCRIPT_CLIENT_ID,
    SemiontBrowser, SemiontSession, SemiontSessionConfig, SessionFactory, SessionFactoryOptions,
    SessionRenewer, SignInKept, SignInOutcome, SignedIn, StoredSession, Validate, kept_in,
    last_event_id_key, person_key, stored_session,
};
use semiont::storage::{SessionStorage, StorageChange, StorageSubscription};
use semiont::transport::BoxFuture;
use semiont::types::{HttpEndpoint, KbDescription, KbEndpoint, KbTarget, UserId};
use std::collections::HashMap;
use std::error::Error;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock, Weak};
use tokio::sync::watch;

/// What a session over a gateway is built with.
pub struct HttpSession {
    pub kb: KbTarget,
    /// Where the session's sign-in is kept.
    pub kept: Arc<dyn SignInKept>,
    /// The gateway's origin.
    pub base_url: String,
    /// The token it starts with, when it has one already.
    pub token: Option<String>,
    pub refresh: Option<Refresh>,
    pub validate: Option<Validate>,
    pub on_auth_failed: Option<OnAuthFailed>,
    pub on_error: Option<OnSessionError>,
    pub http: reqwest::Client,
    pub client: ClientOptions,
    /// What the jitter of the transport's backoffs and of the session's
    /// renewal retry is drawn from; the system's source when none is given.
    pub random: Option<Arc<Mutex<dyn Rng + Send>>>,
}

/// Asks the session to renew: the transport is built first, and holds this,
/// so a renewal asked before the session is made waits for it.
struct Renews(watch::Receiver<Option<SessionRenewer>>);

impl TokenRefresher for Renews {
    fn refresh<'a>(&'a self, refused: Option<&'a str>) -> BoxFuture<'a, Option<String>> {
        let mut session = self.0.clone();
        Box::pin(async move {
            let renewer = match session.wait_for(Option::is_some).await {
                Ok(set) => set.clone(),
                // The sender dropped with nothing sent: no session was made.
                Err(_) => None,
            }?;
            renewer.refresh(refused).await
        })
    }
}

/// A session over the gateway at `base_url`: its transport, its client and
/// the token they share. Whoever this is built for owns the client too.
/// `built` is given the transport and the client before the session is
/// made over them. A token the gateway refuses is renewed through the
/// session, so the transport and the session never hold different ones.
fn built_over_http(
    options: HttpSession,
    built: impl FnOnce(&Arc<HttpTransport>, &Arc<SemiontClient>),
) -> SemiontSession {
    let (token, sent) = watch::channel(options.token);
    let (renewer, renews) = watch::channel(None);
    let transport = Arc::new(HttpTransport::new(HttpTransportConfig {
        base_url: options.base_url,
        token: sent,
        refresher: Some(Arc::new(Renews(renews))),
        channels: None,
        http: options.http,
        timing: Timing::default(),
        random: options.random.clone(),
    }));
    let content = Arc::new(HttpContentTransport::new(&transport));
    let client = Arc::new(SemiontClient::new(
        transport.clone(),
        content,
        Some(transport.clone()),
        options.client,
    ));
    built(&transport, &client);
    let session = SemiontSession::new(SemiontSessionConfig {
        kb: options.kb,
        kept: options.kept,
        client,
        token,
        refresh: options.refresh,
        validate: options.validate,
        on_auth_failed: options.on_auth_failed,
        on_error: options.on_error,
        random: options.random,
    });
    renewer.send_replace(Some(session.renewer()));
    session
}

type Renewal =
    Shared<BoxFuture<'static, Result<Option<String>, Arc<dyn std::error::Error + Send + Sync>>>>;

/// The renewals under way, by knowledge base.
type Renewing = Arc<Mutex<HashMap<String, Renewal>>>;

/// Renew the sign-in `kept` holds of `kb_id` at the issuer it names
/// (`renew_kept`). A renewal asked for while one is under way is that one: a
/// stream refused and a request refused at the same moment spend one refresh
/// token, not two, of which an issuer that rotates them would refuse the
/// second. It goes by the token the first of them holds, and its retries
/// draw their jitter from `random`.
fn renewing_kept(
    kept: Arc<dyn SignInKept>,
    kb_id: String,
    http: reqwest::Client,
    renewing: Renewing,
    random: Option<Arc<Mutex<dyn Rng + Send>>>,
) -> Refresh {
    Arc::new(move |holding: Option<String>| {
        let renewal = locked(&renewing)
            .entry(kb_id.clone())
            .or_insert_with(|| {
                let (kept, kb_id, http, renewing, random) = (
                    kept.clone(),
                    kb_id.clone(),
                    http.clone(),
                    renewing.clone(),
                    random.clone(),
                );
                let once: BoxFuture<
                    'static,
                    Result<Option<String>, Arc<dyn std::error::Error + Send + Sync>>,
                > = Box::pin(async move {
                    let renewed =
                        renew_kept(kept.as_ref(), holding.as_deref(), &http, random.as_deref())
                            .await
                            .map_err(Arc::from);
                    locked(&renewing).remove(&kb_id);
                    renewed
                });
                once.shared()
            })
            .clone();
        Box::pin(renewal)
    })
}

/// Ask the gateway who `token` is: one request, by a caller that holds
/// nothing else. No stream is opened for it, nothing is emitted, and nothing
/// renews the token: a refusal is the answer. So nothing backs off, and no
/// jitter is drawn.
fn asking_the_gateway(base_url: String, http: reqwest::Client) -> Validate {
    Arc::new(move |token| {
        let asking = crate::transport::Shared::new(HttpTransportConfig {
            base_url: base_url.clone(),
            token: watch::channel(Some(token)).1,
            refresher: None,
            channels: Some(Vec::new()),
            http: http.clone(),
            timing: Timing::default(),
            random: None,
        });
        Box::pin(async move { Ok(asking.current_user().await?) })
    })
}

/// The gateway's origin of a knowledge base reached over HTTP. Any other is
/// refused (`session.construct-failed`), before anything is asked, and so is
/// a host that is no host's name.
fn gateway_of(kb: &KbTarget) -> Result<String, SessionError> {
    let refused = |why: String| SessionError::new(SessionErrorCode::ConstructFailed, why, &kb.id);
    let Some(endpoint) = kb.endpoint.http() else {
        return Err(refused(format!(
            "A session over HTTP cannot be built for endpoint kind \"{}\"",
            kb.endpoint.kind()
        )));
    };
    endpoint.gateway_url().map_err(refused)
}

/// Tell the issuer, when the sign-in says where, to forget its refresh
/// token. Best effort: an issuer that could not be told forgets it when it
/// expires.
async fn revoked(sign_in: &StoredSession, http: &reqwest::Client) {
    if let Some(endpoint) = &sign_in.revocation_endpoint {
        let _ = revoke_at_issuer(http, endpoint, &sign_in.client_id, &sign_in.refresh).await;
    }
}

// ── For a script ────────────────────────────────────────────────────────

/// A script's session of a knowledge base, and where its sign-in is kept.
pub struct SessionFromKept {
    pub kb: KbTarget,
    /// Where the sign-in is kept: the file `semiont login` keeps
    /// (`semiont::sign_in_store::SignInStore::entry`), memory
    /// (`semiont::session::MemorySignIn`), a registry's storage
    /// (`semiont::session::kept_in`), or anywhere else.
    pub kept: Arc<dyn SignInKept>,
    /// Whether the gateway is asked who the token is.
    pub validate: bool,
    /// Where the client keeps what a registry's session's client keeps
    /// (`HttpSessionFactory`): its persisted queries and where its stream
    /// was, for the person the kept sign-in names, from the start, or once
    /// the gateway names them and the sign-in records it. With none it
    /// keeps nothing beyond its life.
    pub storage: Option<Arc<dyn SessionStorage>>,
    pub on_auth_failed: Option<OnAuthFailed>,
    pub on_error: Option<OnSessionError>,
    pub http: reqwest::Client,
    /// What the session's jitter is drawn from (`HttpSession::random`).
    pub random: Option<Arc<Mutex<dyn Rng + Send>>>,
}

/// A session over the sign-in `kept` holds, with the client it was built
/// with: it sends the sign-in's token, renews it at the issuer the sign-in
/// names and keeps the renewal there, and forgets the sign-in when the
/// issuer refuses to renew it. Given a storage, its client keeps there what
/// it keeps of the person (`Keeping`). It is ready when this returns. With
/// nothing kept it is signed out: it holds no token, and nobody is asked
/// who it is. A knowledge base reached any other way than over HTTP, or
/// whose host is no host's name, is refused (`session.construct-failed`)
/// before anything is asked.
pub async fn session_from_kept(options: SessionFromKept) -> Result<OpenedSession, SessionError> {
    let base_url = gateway_of(&options.kb)?;
    let asking = options
        .validate
        .then(|| asking_the_gateway(base_url.clone(), options.http.clone()));
    let keeping = options.storage.map(|storage| {
        Arc::new(Keeping {
            storage,
            kept: options.kept.clone(),
            kb_id: options.kb.id.clone(),
            on_error: options.on_error.clone(),
            attached: AtomicBool::new(false),
            built: OnceLock::new(),
        })
    });
    // Read before the client is built: a sign-in that names its person has
    // the client keep for them from its start (B17). One that cannot be
    // read names nobody here: the session finds it unreadable as it starts,
    // and says so.
    let named = match &keeping {
        Some(_) => match options.kept.held().await {
            Ok(held) => held.and_then(|held| held.person_key),
            Err(_) => None,
        },
        None => None,
    };
    let validate = match (&keeping, asking) {
        (Some(keeping), Some(asking)) => Some(asking_and_keeping(asking, keeping.clone())),
        (_, asking) => asking,
    };
    let session = built_over_http(
        HttpSession {
            refresh: Some(renewing_kept(
                options.kept.clone(),
                options.kb.id.clone(),
                options.http.clone(),
                Renewing::default(),
                options.random.clone(),
            )),
            validate,
            kb: options.kb,
            kept: options.kept,
            base_url,
            token: None,
            on_auth_failed: options.on_auth_failed,
            on_error: options.on_error,
            http: options.http,
            client: ClientOptions::default(),
            random: options.random,
        },
        |transport, client| {
            if let Some(keeping) = &keeping {
                keeping.built(transport, client, named.as_deref());
            }
        },
    );
    let opened = OpenedSession::new(session);
    opened.session().ready().await;
    Ok(opened)
}

/// Sign in to `kb` as a person from a process with no browser, and keep the
/// sign-in in `kept`, in place of whatever it kept: a session is then built
/// from it (`session_from_kept`). The issuer the knowledge base trusts mints
/// a code, `on_code` shows the person where to approve it, and the tokens
/// come back here: no password passes through this process. The token
/// endpoint is asked at the issuer's interval, so no jitter is drawn. A
/// failure is a `SignInError`, or the sign-in kept's own error when it would
/// not keep the tokens.
pub async fn sign_in_device(
    kb: &KbTarget,
    kept: &dyn SignInKept,
    on_code: impl FnOnce(DeviceCode),
    http: &reqwest::Client,
) -> Result<(), Box<dyn Error + Send + Sync>> {
    let Some(target) = kb.endpoint.http() else {
        return Err(SignInError::new(
            SignInErrorCode::Discovery,
            format!(
                "The device grant needs an HTTP endpoint; this knowledge base's is \"{}\"",
                kb.endpoint.kind()
            ),
        )
        .into());
    };
    let (issuer, tokens) = sign_in_with_device_grant(target, on_code, http).await?;
    kept.keep(StoredSession {
        access: tokens.access,
        refresh: tokens.refresh,
        client_id: SCRIPT_CLIENT_ID.to_owned(),
        token_endpoint: issuer.token,
        revocation_endpoint: issuer.revocation,
        person_key: None,
    })
    .await
}

/// End the sign-in `kept` holds: it is revoked at its issuer, when the
/// issuer says where, and kept no more. It is forgotten whatever the issuer
/// answers: a person who signs out is signed out here, and an issuer that
/// could not be told forgets the token when it expires. Forgetting a sign-in
/// a registry keeps (`semiont::session::kept_in`) deletes what was kept for
/// the person it named too; one kept anywhere else deletes nothing. With
/// nothing kept, nothing is asked. What the sign-in kept could not read or
/// forget is its own error.
pub async fn sign_out(
    kept: &dyn SignInKept,
    http: &reqwest::Client,
) -> Result<(), Box<dyn Error + Send + Sync>> {
    let Some(held) = kept.held().await? else {
        return Ok(());
    };
    revoked(&held, http).await;
    kept.forget().await
}

// ── What a session's client keeps of its person ─────────────────────────

/// The storage a person's caches and places are written through: a write is
/// made only while the knowledge base's kept sign-in names the person.
/// Once it does not (forgotten, here or in another context, however it was
/// forgotten, or replaced by a sign-in of someone else, or of someone the
/// gateway has not named yet) nothing more is written for the client's
/// life, and what it had not written is dropped, which is no failure
/// (protocol/specs/src/session/persisted-cases.json, `crossTab`). So what
/// forgetting the sign-in deletes, the client does not put back (`forget`).
/// A sign-in that cannot be read is not known to name the person: nothing
/// more is written either, and `on_error`, when there is one, is told once
/// (`session.keep-failed`). A write the storage refuses is the storage's
/// error. Every write reaches this under the one lock the client's
/// persisted caches write under, so a check and the write it allows are one
/// step, and the session's own forget, which takes that lock before it
/// deletes, never falls between them.
struct ForThePerson {
    storage: Arc<dyn SessionStorage>,
    kept: Arc<dyn SignInKept>,
    kb_id: String,
    person_key: String,
    moved_on: AtomicBool,
    on_error: Option<OnSessionError>,
}

impl ForThePerson {
    fn named(&self) -> bool {
        if self.moved_on.load(Ordering::SeqCst) {
            return false;
        }
        // The check is made under the lock the client writes under, where
        // nothing awaits: the read is driven to its end here. The sign-in of
        // a registry's session is kept in its storage (`kept_in`), whose
        // read is ready the moment it is asked; a script's may be kept
        // anywhere (`SessionFromKept::kept`), and its read is driven to its
        // end all the same.
        match futures::executor::block_on(self.kept.held()) {
            Ok(held) => {
                let named = held.is_some_and(|held| {
                    held.person_key.as_deref() == Some(self.person_key.as_str())
                });
                if !named {
                    self.moved_on.store(true, Ordering::SeqCst);
                }
                named
            }
            Err(unread) => {
                if !self.moved_on.swap(true, Ordering::SeqCst)
                    && let Some(on_error) = &self.on_error
                {
                    on_error(SessionError::new(
                        SessionErrorCode::KeepFailed,
                        format!(
                            "The sign-in could not be read before what the client keeps was saved, so it keeps nothing more: {unread}"
                        ),
                        &self.kb_id,
                    ));
                }
                false
            }
        }
    }
}

impl SessionStorage for ForThePerson {
    fn get(&self, key: &str) -> Option<String> {
        self.storage.get(key)
    }

    fn set(&self, key: &str, value: &str) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        if !self.named() {
            return Ok(());
        }
        self.storage.set(key, value)
    }

    fn delete(&self, key: &str) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        if !self.named() {
            return Ok(());
        }
        self.storage.delete(key)
    }

    fn update(
        &self,
        key: &str,
        change: &mut dyn FnMut(Option<&str>) -> Option<String>,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        if !self.named() {
            return Ok(());
        }
        self.storage.update(key, change)
    }

    fn subscribe(&self, on_change: StorageChange) -> Option<StorageSubscription> {
        self.storage.subscribe(on_change)
    }
}

/// What a session keeps of the person its token is, in a storage (a
/// registry's, or a script's): the client's persisted queries and where its
/// stream was, under the knowledge base's id and the person's key
/// (protocol/specs/src/session/persisted-cases.json). Nothing is kept until
/// the person is known: from the start when the kept sign-in names them,
/// or once the gateway names them and the sign-in records it.
struct Keeping {
    storage: Arc<dyn SessionStorage>,
    /// The session's sign-in.
    kept: Arc<dyn SignInKept>,
    kb_id: String,
    on_error: Option<OnSessionError>,
    /// Whether the client keeps for a person: it does for one in its life.
    attached: AtomicBool,
    /// The transport and the client, once they are built.
    built: OnceLock<(Weak<HttpTransport>, Weak<SemiontClient>)>,
}

impl Keeping {
    /// The transport and the client are built: keep for the person whose
    /// key is `named`, when the kept sign-in names one already.
    fn built(
        &self,
        transport: &Arc<HttpTransport>,
        client: &Arc<SemiontClient>,
        named: Option<&str>,
    ) {
        let _ = self
            .built
            .set((Arc::downgrade(transport), Arc::downgrade(client)));
        if let Some(person_key) = named {
            self.attach(person_key);
        }
    }

    /// Record on the kept sign-in that the gateway named the person whose
    /// key is `person_key` as who `access` is (`SignInKept::record_person_key`).
    /// Whether it names them now: a sign-in that will not take the record
    /// does not, and keeps nothing of them.
    async fn record(&self, access: &str, person_key: &str) -> bool {
        matches!(
            self.kept.record_person_key(access, person_key).await,
            Ok(true)
        )
    }

    /// Keep what the client keeps of the person whose key is `person_key`,
    /// from now on: its persisted queries take in what was kept for them and
    /// are saved there, and the stream resumes each scope it holds no place
    /// for from the person's place. A client keeps for one person in its
    /// life: a second attach changes nothing.
    fn attach(&self, person_key: &str) {
        let Some((transport, client)) = self
            .built
            .get()
            .and_then(|(transport, client)| Some((transport.upgrade()?, client.upgrade()?)))
        else {
            return;
        };
        if self.attached.swap(true, Ordering::SeqCst) {
            return;
        }
        let places = CoupledBookmarks::new(
            Arc::new(ForThePerson {
                storage: self.storage.clone(),
                kept: self.kept.clone(),
                kb_id: self.kb_id.clone(),
                person_key: person_key.to_owned(),
                moved_on: AtomicBool::new(false),
                on_error: self.on_error.clone(),
            }),
            &last_event_id_key(&self.kb_id, person_key),
        );
        // The stream's place rides the caches' writes, and only when every
        // cache is at rest and no refetch is owed: a place kept ahead of a
        // cache still taking in the event it names would have the next life
        // skip that event.
        places.couple_to(&client);
        client.attach_persistence(&CachePersistence {
            storage: places.storage(),
            kb_id: self.kb_id.clone(),
            person_key: person_key.to_owned(),
        });
        transport.restore_places(places.load());
    }
}

/// Ask the gateway who a token is, as `asking` does, and once it names the
/// person, record them on the kept sign-in and keep what the client keeps
/// for them. Both are done before the answer is given, so before the
/// session is ready.
fn asking_and_keeping(asking: Validate, keeping: Arc<Keeping>) -> Validate {
    Arc::new(move |token: String| {
        let asked = asking(token.clone());
        let keeping = keeping.clone();
        Box::pin(async move {
            let user = asked.await?;
            let person = person_key(&user.did);
            if keeping.record(&token, &person).await {
                keeping.attach(&person);
            }
            Ok(user)
        })
    })
}

/// Builds the session of each knowledge base a `SemiontBrowser` activates,
/// over its gateway, from the sign-in the registry keeps in its storage
/// (`kept_in`). What the session's client keeps of its person is kept in
/// the registry's storage too (`Keeping`). The renewals under way are the
/// factory's, so a knowledge base's old session and its new one, during a
/// sign-in, do not each renew. Every session it builds draws its jitter from
/// the factory's `random`, the system's source when it is `None`.
pub struct HttpSessionFactory {
    http: reqwest::Client,
    renewing: Renewing,
    random: Option<Arc<Mutex<dyn Rng + Send>>>,
}

impl HttpSessionFactory {
    pub fn new(
        http: reqwest::Client,
        random: Option<Arc<Mutex<dyn Rng + Send>>>,
    ) -> HttpSessionFactory {
        HttpSessionFactory {
            http,
            renewing: Arc::default(),
            random,
        }
    }
}

impl SessionFactory for HttpSessionFactory {
    fn session(&self, options: SessionFactoryOptions) -> Result<SemiontSession, SessionError> {
        let kb = options.kb.target();
        let base_url = gateway_of(&kb)?;
        let kept = kept_in(options.storage.clone(), &kb.id);

        let refresh = renewing_kept(
            kept.clone(),
            kb.id.clone(),
            self.http.clone(),
            self.renewing.clone(),
            self.random.clone(),
        );

        let keeping = Arc::new(Keeping {
            storage: options.storage.clone(),
            kept: kept.clone(),
            kb_id: kb.id.clone(),
            on_error: Some(options.on_error.clone()),
            attached: AtomicBool::new(false),
            built: OnceLock::new(),
        });
        // Read before the client is built: a sign-in that names its person
        // has the client keep for them from its start (B17).
        let named =
            stored_session(options.storage.as_ref(), &kb.id).and_then(|stored| stored.person_key);
        let signals = options.signals;
        let session = built_over_http(
            HttpSession {
                kb,
                kept,
                base_url: base_url.clone(),
                token: None,
                refresh: Some(refresh),
                validate: Some(asking_and_keeping(
                    asking_the_gateway(base_url, self.http.clone()),
                    keeping.clone(),
                )),
                on_auth_failed: Some(Arc::new(move |reason| {
                    signals.notify_session_ended(reason);
                })),
                on_error: Some(options.on_error),
                http: self.http.clone(),
                client: ClientOptions::default(),
                random: self.random.clone(),
            },
            |transport, client| keeping.built(transport, client, named.as_deref()),
        );
        Ok(session)
    }

    fn revoke(&self, stored: StoredSession) -> BoxFuture<'static, ()> {
        let http = self.http.clone();
        Box::pin(async move { revoked(&stored, &http).await })
    }
}

// ── What a completed sign-in learns ─────────────────────────────────────

/// Who the knowledge base at an address says it is.
#[derive(Debug, Clone, PartialEq)]
pub struct ConnectionIdentity {
    pub did: UserId,
    pub description: KbDescription,
}

/// Ask the knowledge base at `target` what it is, with a token just issued.
/// It describes itself only to a caller that is signed in, so this is asked
/// after the sign-in and never assumed from the address a person typed or
/// the row they clicked. The client it asks with draws its jitter from
/// `random`, the system's source when it is `None`.
pub async fn describe_connection(
    target: &HttpEndpoint,
    access: &str,
    http: &reqwest::Client,
    random: Option<Arc<Mutex<dyn Rng + Send>>>,
) -> Result<ConnectionIdentity, IdentityUnverifiable> {
    let unverifiable = |reason, detail: String| IdentityUnverifiable { reason, detail };
    let base_url = target
        .gateway_url()
        .map_err(|invalid| unverifiable(IdentityUnverifiableReason::Unreachable, invalid))?;
    // A client of this one operation: it hears its replies and nothing else.
    let transport = Arc::new(HttpTransport::new(HttpTransportConfig {
        base_url,
        token: watch::channel(Some(access.to_owned())).1,
        refresher: None,
        channels: Some(
            reply_channels_for(&[BrowseKbRequested::NAME])
                .into_iter()
                .map(str::to_owned)
                .collect(),
        ),
        http: http.clone(),
        timing: Timing::default(),
        random,
    }));
    let client = SemiontClient::new(
        transport.clone(),
        Arc::new(HttpContentTransport::new(&transport)),
        Some(transport),
        ClientOptions::default(),
    );
    let answered = client.browse.kb().await;
    client.close().await;
    let description = match answered {
        Ok(description) => description,
        // A refusal is the knowledge base answering that it cannot say what
        // it is. Anything else is not having reached it.
        Err(SemiontError::Bus(refusal)) if refusal.code == BusRequestErrorCode::Rejected => {
            return Err(unverifiable(
                IdentityUnverifiableReason::NotReported,
                refusal.to_string(),
            ));
        }
        Err(other) => {
            return Err(unverifiable(
                IdentityUnverifiableReason::Unreachable,
                other.to_string(),
            ));
        }
    };
    // A domain no did can hold says nothing of who this is.
    let did = semiont::identity::kb_did(&description.domain)
        .parse::<UserId>()
        .map_err(|invalid| {
            unverifiable(IdentityUnverifiableReason::NotReported, invalid.to_string())
        })?;
    Ok(ConnectionIdentity { did, description })
}

// ── A registry's sign-in through the issuer ─────────────────────────────

/// Begin a sign-in for a registry: find the issuer the target trusts,
/// remember the pending sign-in in the registry's storage, and give the URL
/// to send the person to. A failure is a `SignInError`, or the storage's own
/// error when it would not keep the pending sign-in.
pub async fn begin_sign_in(
    browser: &SemiontBrowser,
    options: BeginAuthorization,
    http: &reqwest::Client,
) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    begin_authorization(options, browser.storage().as_ref(), http).await
}

/// Finish a sign-in from the URL the issuer sent the person back to:
/// exchange the code, ask the knowledge base who it is, and have the
/// registry land the sign-in on the entry for the knowledge base that
/// answered (`SemiontBrowser::signed_in`). A knowledge base that cannot say
/// who it is is not registered, and nothing is stored. A failure is a
/// `SignInError` when the grant failed, an `IdentityUnverifiable` when the
/// knowledge base could not say who it is, or the storage's own error. The
/// knowledge base is asked as `describe_connection` asks, with `random`.
pub async fn complete_sign_in(
    browser: &SemiontBrowser,
    callback_url: &str,
    http: &reqwest::Client,
    random: Option<Arc<Mutex<dyn Rng + Send>>>,
) -> Result<SignInOutcome, Box<dyn std::error::Error + Send + Sync>> {
    let (pending, tokens) =
        complete_authorization(callback_url, browser.storage().as_ref(), http).await?;
    let identity = describe_connection(&pending.target, &tokens.access, http, random).await?;
    browser
        .signed_in(SignedIn {
            endpoint: KbEndpoint::HttpEndpoint(pending.target),
            description: identity.description,
            session: StoredSession {
                access: tokens.access,
                refresh: tokens.refresh,
                client_id: BROWSER_CLIENT_ID.to_owned(),
                token_endpoint: pending.issuer.token,
                revocation_endpoint: pending.issuer.revocation,
                person_key: None,
            },
            kb_id: pending.kb_id,
            expected_did: pending.expected_did,
            expected_name: pending.expected_name,
        })
        .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use semiont::session::MemorySignIn;
    use semiont::storage::InMemorySessionStorage;
    use semiont::testing::{TestClientOptions, create_test_client};
    use semiont::types::LocalEndpoint;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// A session whose renewal answers `renewed`, counted each time it is asked.
    fn renewing(asked: Arc<AtomicUsize>) -> SemiontSession {
        SemiontSession::new(SemiontSessionConfig {
            kb: KbTarget {
                id: "kb".to_owned(),
                label: "KB".to_owned(),
                endpoint: KbEndpoint::LocalEndpoint(LocalEndpoint::new("here")),
            },
            kept: Arc::new(MemorySignIn::new()),
            client: create_test_client(TestClientOptions::default()).client,
            token: watch::channel(None).0,
            refresh: Some(Arc::new(move |_| {
                asked.fetch_add(1, Ordering::SeqCst);
                Box::pin(async { Ok(Some("renewed".to_owned())) })
            })),
            validate: None,
            on_auth_failed: None,
            on_error: None,
            random: None,
        })
    }

    #[tokio::test]
    async fn a_renewal_asked_before_the_session_is_set_waits_for_it_and_is_the_sessions() {
        let asked = Arc::new(AtomicUsize::new(0));
        let session = renewing(asked.clone());
        let (set, unset) = watch::channel(None);
        let renews = Renews(unset);

        let mut renewal = renews.refresh(None);
        assert_eq!(
            (&mut renewal).now_or_never(),
            None,
            "a renewal asked before the session is set waits for it"
        );
        set.send_replace(Some(session.renewer()));
        assert_eq!(renewal.await.as_deref(), Some("renewed"));
        assert_eq!(asked.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn a_renewal_asked_of_a_session_never_set_is_none() {
        let (set, unset) = watch::channel(None);
        let renews = Renews(unset);
        drop(set);
        assert_eq!(renews.refresh(None).await, None);
    }

    // ── What a registry's session keeps, when its sign-in cannot be read ──
    //
    // Every write of what a registry's session keeps of its person, its
    // persisted queries' and its stream's places alike, reaches the storage
    // through `ForThePerson`, which reads the session's sign-in first.

    const ALICE: &str = "did:web:example.org:users:alice";

    /// A sign-in that names alice, and cannot be read while `unreadable`
    /// holds.
    struct Kept {
        names: StoredSession,
        unreadable: AtomicBool,
    }

    impl Kept {
        fn naming_alice() -> Kept {
            Kept {
                names: StoredSession {
                    access: "a1".to_owned(),
                    refresh: "r1".to_owned(),
                    client_id: BROWSER_CLIENT_ID.to_owned(),
                    token_endpoint: "https://issuer.test/token".to_owned(),
                    revocation_endpoint: None,
                    person_key: Some(person_key(ALICE)),
                },
                unreadable: AtomicBool::new(false),
            }
        }
    }

    impl SignInKept for Kept {
        fn held(
            &self,
        ) -> BoxFuture<'_, Result<Option<StoredSession>, Box<dyn Error + Send + Sync>>> {
            Box::pin(async move {
                if self.unreadable.load(Ordering::SeqCst) {
                    return Err("the sign-in could not be read".into());
                }
                Ok(Some(self.names.clone()))
            })
        }

        fn keep(
            &self,
            _: StoredSession,
        ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
            panic!("nothing is kept")
        }

        fn renewed<'a>(
            &'a self,
            _: &'a StoredSession,
            _: &'a str,
            _: &'a str,
        ) -> BoxFuture<'a, Result<Option<String>, Box<dyn Error + Send + Sync>>> {
            panic!("nothing is renewed")
        }

        fn record_person_key<'a>(
            &'a self,
            _: &'a str,
            _: &'a str,
        ) -> BoxFuture<'a, Result<bool, Box<dyn Error + Send + Sync>>> {
            panic!("nobody is recorded")
        }

        fn forget(&self) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
            panic!("nothing is forgotten")
        }
    }

    /// What alice's session keeps, written through to `storage` over `kept`,
    /// and every failure it tells.
    fn keeping_for_alice(
        storage: Arc<InMemorySessionStorage>,
        kept: Arc<Kept>,
    ) -> (ForThePerson, Arc<Mutex<Vec<SessionError>>>) {
        let told: Arc<Mutex<Vec<SessionError>>> = Arc::default();
        let telling = told.clone();
        let keeping = ForThePerson {
            storage,
            kept,
            kb_id: "kb".to_owned(),
            person_key: person_key(ALICE),
            moved_on: AtomicBool::new(false),
            on_error: Some(Arc::new(move |failure| locked(&telling).push(failure))),
        };
        (keeping, told)
    }

    #[test]
    fn what_a_session_keeps_is_written_while_its_sign_in_names_the_person() {
        let storage = Arc::new(InMemorySessionStorage::new());
        let (keeping, told) = keeping_for_alice(storage.clone(), Arc::new(Kept::naming_alice()));

        keeping.set("a", "1").expect("written");
        keeping
            .update("b", &mut |_| Some("2".to_owned()))
            .expect("written");

        assert_eq!(storage.get("a").as_deref(), Some("1"));
        assert_eq!(storage.get("b").as_deref(), Some("2"));
        assert!(locked(&told).is_empty());
    }

    /// A sign-in that cannot be read when the client saves is not known to
    /// name the person: the save is not written, and nor is any after it,
    /// though the sign-in reads again and names them. The session is told
    /// once, and goes on.
    #[test]
    fn a_sign_in_that_cannot_be_read_at_a_save_ends_what_the_session_keeps_and_says_so_once() {
        let storage = Arc::new(InMemorySessionStorage::new());
        let kept = Arc::new(Kept::naming_alice());
        let (keeping, told) = keeping_for_alice(storage.clone(), kept.clone());
        keeping.set("a", "1").expect("written");
        kept.unreadable.store(true, Ordering::SeqCst);

        keeping
            .set("a", "2")
            .expect("a save not written is no failure");
        keeping
            .update("b", &mut |_| Some("2".to_owned()))
            .expect("a save not written is no failure");
        keeping
            .delete("a")
            .expect("a save not written is no failure");
        kept.unreadable.store(false, Ordering::SeqCst);
        keeping
            .set("c", "3")
            .expect("a save not written is no failure");

        assert_eq!(storage.get("a").as_deref(), Some("1"));
        assert_eq!(storage.get("b"), None);
        assert_eq!(storage.get("c"), None);
        let told = locked(&told);
        assert_eq!(
            told.iter()
                .map(|failure| (failure.code, failure.kb_id.as_deref()))
                .collect::<Vec<_>>(),
            [(SessionErrorCode::KeepFailed, Some("kb"))]
        );
        assert!(
            told[0].message.contains("the sign-in could not be read"),
            "{}",
            told[0].message
        );
    }
}
