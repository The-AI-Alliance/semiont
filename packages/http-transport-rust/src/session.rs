//! Sessions with a knowledge base over its gateway: what builds one
//! (`HttpSessionFactory`, for a registry of knowledge bases, and the three
//! functions a script uses directly), what a completed sign-in learns of the
//! knowledge base it reached, and a registry's sign-in through the issuer.
//!
//! A session built here renews its token at the issuer its stored session
//! names. Renewals of one knowledge base that are asked for together are one
//! request: several requests refused at once ask for one new token.
//!
//! A person's token is one credential source. An agent's is another
//! (`crate::agent`), which feeds a transport the same way.

use crate::content::HttpContentTransport;
use crate::oauth::{
    BeginAuthorization, DeviceCode, begin_authorization, complete_authorization,
    refresh_stored_session, revoke_at_issuer, sign_in_with_device_grant,
};
use crate::transport::{
    Bookmarks, HttpTransport, HttpTransportConfig, Timing, TokenRefresher, locked,
};
use futures::FutureExt;
use futures::future::Shared;
use semiont::bus::reply_channels_for;
use semiont::channels::{BrowseKbRequested, Channel};
use semiont::client::{CachePersistence, ClientOptions, SemiontClient};
use semiont::errors::{
    BusRequestErrorCode, IdentityUnverifiable, IdentityUnverifiableReason, SemiontError,
    SessionError, SessionErrorCode, SignInError, SignInErrorCode,
};
use semiont::resume::CoupledBookmarks;
use semiont::session::{
    BROWSER_CLIENT_ID, HttpEndpoint, KbEndpoint, KbTarget, OnAuthFailed, OnSessionError, Refresh,
    SCRIPT_CLIENT_ID, SemiontBrowser, SemiontSession, SemiontSessionConfig, SessionFactory,
    SessionFactoryOptions, SessionRenewer, SignInOutcome, SignedIn, StoredSession, Validate,
    store_session, stored_session,
};
use semiont::storage::SessionStorage;
use semiont::transport::{BoxFuture, GatewayOperations, Transport};
use semiont::types::KbDescription;
use std::collections::HashMap;
use std::fmt;
use std::sync::{Arc, Mutex, OnceLock};
use tokio::sync::watch;

/// What a session over a gateway is built with.
pub struct HttpSession {
    pub kb: KbTarget,
    /// Where the session's tokens are kept.
    pub storage: Arc<dyn SessionStorage>,
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
    /// Where the stream's place is kept across the session's lives.
    pub bookmarks: Option<Arc<dyn Bookmarks>>,
}

/// Asks the session to renew, once there is one: the transport is built
/// first, and holds this.
struct Renews(Arc<OnceLock<SessionRenewer>>);

impl TokenRefresher for Renews {
    fn refresh(&self) -> BoxFuture<'_, Option<String>> {
        Box::pin(async move {
            match self.0.get() {
                Some(renewer) => renewer.refresh().await,
                None => None,
            }
        })
    }
}

/// A session over the gateway at `base_url`: its transport, its client and
/// the token they share. A token the gateway refuses is renewed through the
/// session, so the transport and the session never hold different ones.
pub fn session_over_http(options: HttpSession) -> SemiontSession {
    let (token, sent) = watch::channel(options.token);
    let renewer = Arc::new(OnceLock::new());
    let transport = Arc::new(HttpTransport::new(HttpTransportConfig {
        base_url: options.base_url,
        token: sent,
        refresher: Some(Arc::new(Renews(renewer.clone()))),
        channels: None,
        http: options.http,
        timing: Timing::default(),
        bookmarks: options.bookmarks,
    }));
    let content = Arc::new(HttpContentTransport::new(&transport));
    let client = Arc::new(SemiontClient::new(
        transport.clone(),
        content,
        Some(transport),
        options.client,
    ));
    let session = SemiontSession::new(SemiontSessionConfig {
        kb: options.kb,
        storage: options.storage,
        client,
        token,
        refresh: options.refresh,
        validate: options.validate,
        on_auth_failed: options.on_auth_failed,
        on_error: options.on_error,
    });
    let _ = renewer.set(session.renewer());
    session
}

type Renewal = Shared<BoxFuture<'static, Result<Option<String>, String>>>;

/// The renewals under way, by knowledge base.
type Renewing = Arc<Mutex<HashMap<String, Renewal>>>;

/// Renew at the issuer the stored session of `kb_id` names. A renewal asked
/// for while one is under way is that one: a stream refused and a request
/// refused at the same moment spend one refresh token, not two, of which an
/// issuer that rotates them would refuse the second.
fn renewing_stored(
    storage: Arc<dyn SessionStorage>,
    kb_id: String,
    http: reqwest::Client,
    renewing: Renewing,
) -> Refresh {
    Arc::new(move || {
        let renewal = locked(&renewing)
            .entry(kb_id.clone())
            .or_insert_with(|| {
                let (storage, kb_id, http, renewing) = (
                    storage.clone(),
                    kb_id.clone(),
                    http.clone(),
                    renewing.clone(),
                );
                let once: BoxFuture<'static, Result<Option<String>, String>> =
                    Box::pin(async move {
                        let renewed = refresh_stored_session(storage.as_ref(), &kb_id, &http)
                            .await
                            .map_err(|refused| refused.to_string());
                        locked(&renewing).remove(&kb_id);
                        renewed
                    });
                once.shared()
            })
            .clone();
        Box::pin(renewal)
    })
}

/// Ask the gateway who `token` is, as a client that holds nothing else.
fn asking_the_gateway(base_url: String, http: reqwest::Client) -> Validate {
    Arc::new(move |token| {
        let (base_url, http) = (base_url.clone(), http.clone());
        Box::pin(async move {
            let transport = HttpTransport::new(HttpTransportConfig {
                base_url,
                token: watch::channel(Some(token)).1,
                refresher: None,
                channels: Some(Vec::new()),
                http,
                timing: Timing::default(),
                bookmarks: None,
            });
            let user = transport.get_current_user().await;
            transport.close().await;
            Ok(user?)
        })
    })
}

/// Tokens an issuer has already issued, and the knowledge base they are for.
pub struct IssuedSession {
    pub kb: KbTarget,
    pub storage: Arc<dyn SessionStorage>,
    pub base_url: String,
    pub session: StoredSession,
    /// Whether the gateway is asked who the token is.
    pub validate: bool,
    pub on_auth_failed: Option<OnAuthFailed>,
    pub on_error: Option<OnSessionError>,
    pub http: reqwest::Client,
}

/// A session over tokens an issuer has already issued: a completed sign-in,
/// a device grant, a pair minted for a test. They are kept under the
/// knowledge base's id, the session renews at the issuer they name, and it
/// is ready when this returns.
pub async fn session_from_issued(issued: IssuedSession) -> SemiontSession {
    store_session(issued.storage.as_ref(), &issued.kb.id, &issued.session);
    over_stored(
        StoredSignIn {
            kb: issued.kb,
            storage: issued.storage,
            base_url: issued.base_url,
            validate: issued.validate,
            on_auth_failed: issued.on_auth_failed,
            on_error: issued.on_error,
            http: issued.http,
        },
        issued.session.access,
    )
    .await
}

/// A sign-in a storage already holds, and the knowledge base it is for.
pub struct StoredSignIn {
    pub kb: KbTarget,
    /// Where the sign-in is kept, under the knowledge base's id.
    pub storage: Arc<dyn SessionStorage>,
    pub base_url: String,
    /// Whether the gateway is asked who the token is.
    pub validate: bool,
    pub on_auth_failed: Option<OnAuthFailed>,
    pub on_error: Option<OnSessionError>,
    pub http: reqwest::Client,
}

/// A session over the sign-in `storage` holds for the knowledge base: the
/// one `semiont login` made, when the storage is a `SignInStore`, or one
/// this application kept earlier. It renews at the issuer the sign-in
/// names, and is ready when this returns. `None` when the storage holds no
/// sign-in for the knowledge base.
pub async fn session_from_stored(stored: StoredSignIn) -> Option<SemiontSession> {
    let held = stored_session(stored.storage.as_ref(), &stored.kb.id)?;
    Some(over_stored(stored, held.access).await)
}

/// A ready session that starts with `access` and renews from what is
/// stored.
async fn over_stored(stored: StoredSignIn, access: String) -> SemiontSession {
    let session = session_over_http(HttpSession {
        refresh: Some(renewing_stored(
            stored.storage.clone(),
            stored.kb.id.clone(),
            stored.http.clone(),
            Renewing::default(),
        )),
        validate: stored
            .validate
            .then(|| asking_the_gateway(stored.base_url.clone(), stored.http.clone())),
        kb: stored.kb,
        storage: stored.storage,
        base_url: stored.base_url,
        token: Some(access),
        on_auth_failed: stored.on_auth_failed,
        on_error: stored.on_error,
        http: stored.http,
        client: ClientOptions::default(),
        bookmarks: None,
    });
    session.ready().await;
    session
}

/// A sign-in by the device grant.
pub struct SignInDevice {
    pub kb: KbTarget,
    pub storage: Arc<dyn SessionStorage>,
    pub validate: bool,
    pub on_auth_failed: Option<OnAuthFailed>,
    pub on_error: Option<OnSessionError>,
    pub http: reqwest::Client,
}

/// Sign in as a person from a process with no browser, and give the session.
/// The issuer the knowledge base trusts mints a code, `on_code` shows the
/// person where to approve it, and the tokens come back here: no password
/// passes through this process.
pub async fn sign_in_device(
    options: SignInDevice,
    on_code: impl FnOnce(DeviceCode),
) -> Result<SemiontSession, SignInError> {
    let Some(target) = options.kb.endpoint.http().cloned() else {
        return Err(SignInError::new(
            SignInErrorCode::Discovery,
            format!(
                "The device grant needs an HTTP endpoint; this knowledge base's is \"{}\"",
                options.kb.endpoint.kind()
            ),
        ));
    };
    let base_url = target
        .gateway_url()
        .map_err(|invalid| SignInError::new(SignInErrorCode::Discovery, invalid))?;
    let (issuer, tokens) = sign_in_with_device_grant(&target, on_code, &options.http).await?;
    Ok(session_from_issued(IssuedSession {
        kb: options.kb,
        storage: options.storage,
        base_url,
        session: StoredSession {
            access: tokens.access,
            refresh: tokens.refresh,
            client_id: SCRIPT_CLIENT_ID.to_owned(),
            token_endpoint: issuer.token,
            revocation_endpoint: issuer.revocation,
        },
        validate: options.validate,
        on_auth_failed: options.on_auth_failed,
        on_error: options.on_error,
        http: options.http,
    })
    .await)
}

// ── For a registry of knowledge bases ───────────────────────────────────

/// The places a client's caches carry, as the stream's bookmarks.
struct Kept(CoupledBookmarks);

impl Bookmarks for Kept {
    fn load(&self) -> HashMap<String, String> {
        self.0.load()
    }

    fn save(&self, scope: &str, event_id: &str) {
        self.0.save(scope, event_id);
    }
}

/// Builds the session of each knowledge base a `SemiontBrowser` activates,
/// over its gateway. The session's caches are kept in the registry's
/// storage, under the knowledge base's id. The renewals under way are the
/// factory's, so a knowledge base's old session and its new one, during a
/// sign-in, do not each renew.
pub struct HttpSessionFactory {
    http: reqwest::Client,
    renewing: Renewing,
}

impl HttpSessionFactory {
    pub fn new(http: reqwest::Client) -> HttpSessionFactory {
        HttpSessionFactory {
            http,
            renewing: Arc::default(),
        }
    }
}

impl SessionFactory for HttpSessionFactory {
    fn session(&self, options: SessionFactoryOptions) -> Result<SemiontSession, SessionError> {
        let kb_id = options.kb.id.clone();
        let refused =
            |why: String| SessionError::new(SessionErrorCode::ConstructFailed, why, &kb_id);
        let Some(endpoint) = options.kb.endpoint.http() else {
            return Err(refused(format!(
                "HTTP session factory cannot construct a session for endpoint kind \"{}\"",
                options.kb.endpoint.kind()
            )));
        };
        let base_url = endpoint.gateway_url().map_err(refused)?;

        let refresh = renewing_stored(
            options.storage.clone(),
            kb_id.clone(),
            self.http.clone(),
            self.renewing.clone(),
        );

        // The stream's place rides the caches' writes, and only when every
        // cache is at rest: a place kept ahead of a cache still taking in
        // the event it names would have the next life skip that event.
        let kept = CoupledBookmarks::new(
            options.storage.clone(),
            &format!("semiont.lastEventId.{kb_id}"),
        );
        let signals = options.signals;
        let session = session_over_http(HttpSession {
            kb: options.kb.target(),
            base_url: base_url.clone(),
            token: None,
            refresh: Some(refresh),
            validate: Some(asking_the_gateway(base_url, self.http.clone())),
            on_auth_failed: Some(Arc::new(move |message| {
                signals.notify_session_expired(Some(message));
            })),
            on_error: Some(options.on_error),
            http: self.http.clone(),
            client: ClientOptions {
                cache_persistence: Some(CachePersistence {
                    storage: kept.storage(),
                    key_prefix: kb_id.clone(),
                }),
                ..ClientOptions::default()
            },
            bookmarks: Some(Arc::new(Kept(kept.clone()))),
            storage: options.storage,
        });
        let client = Arc::downgrade(session.client());
        kept.set_flush_gate(move || {
            client
                .upgrade()
                .is_some_and(|client| client.persistence_settled())
        });
        Ok(session)
    }

    fn revoke(&self, stored: StoredSession) -> BoxFuture<'static, ()> {
        let http = self.http.clone();
        Box::pin(async move {
            if let Some(endpoint) = &stored.revocation_endpoint {
                let _ = revoke_at_issuer(&http, endpoint, &stored.client_id, &stored.refresh).await;
            }
        })
    }
}

// ── What a completed sign-in learns ─────────────────────────────────────

/// Who the knowledge base at an address says it is.
#[derive(Debug, Clone, PartialEq)]
pub struct ConnectionIdentity {
    pub did: String,
    pub description: KbDescription,
}

/// Ask the knowledge base at `target` what it is, with a token just issued.
/// It describes itself only to a caller that is signed in, so this is asked
/// after the sign-in and never assumed from the address a person typed or
/// the row they clicked.
pub async fn describe_connection(
    target: &HttpEndpoint,
    access: &str,
    http: &reqwest::Client,
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
        bookmarks: None,
    }));
    let client = SemiontClient::new(
        transport.clone(),
        Arc::new(HttpContentTransport::new(&transport)),
        Some(transport),
        ClientOptions::default(),
    );
    let answered = client.browse.kb().await;
    client.close().await;
    match answered {
        Ok(description) => Ok(ConnectionIdentity {
            did: semiont::identity::kb_did(&description.domain),
            description,
        }),
        // A refusal is the knowledge base answering that it cannot say what
        // it is. Anything else is not having reached it.
        Err(SemiontError::Bus(refusal)) if refusal.code == BusRequestErrorCode::Rejected => Err(
            unverifiable(IdentityUnverifiableReason::NotReported, refusal.to_string()),
        ),
        Err(other) => Err(unverifiable(
            IdentityUnverifiableReason::Unreachable,
            other.to_string(),
        )),
    }
}

// ── A registry's sign-in through the issuer ─────────────────────────────

/// Begin a sign-in for a registry: find the issuer the target trusts,
/// remember the pending sign-in in the registry's storage, and give the URL
/// to send the person to.
pub async fn begin_sign_in(
    browser: &SemiontBrowser,
    options: BeginAuthorization,
    http: &reqwest::Client,
) -> Result<String, SignInError> {
    begin_authorization(options, browser.storage().as_ref(), http).await
}

/// Why a sign-in did not complete: the grant failed, or it succeeded and
/// the knowledge base could not say who it is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CompleteSignInError {
    SignIn(SignInError),
    Identity(IdentityUnverifiable),
}

impl fmt::Display for CompleteSignInError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CompleteSignInError::SignIn(error) => error.fmt(f),
            CompleteSignInError::Identity(error) => error.fmt(f),
        }
    }
}

impl std::error::Error for CompleteSignInError {}

/// Finish a sign-in from the URL the issuer sent the person back to:
/// exchange the code, ask the knowledge base who it is, and have the
/// registry land the sign-in on the entry for the knowledge base that
/// answered (`SemiontBrowser::signed_in`). A knowledge base that cannot say
/// who it is is not registered, and nothing is stored.
pub async fn complete_sign_in(
    browser: &SemiontBrowser,
    callback_url: &str,
    http: &reqwest::Client,
) -> Result<SignInOutcome, CompleteSignInError> {
    let (pending, tokens) = complete_authorization(callback_url, browser.storage().as_ref(), http)
        .await
        .map_err(CompleteSignInError::SignIn)?;
    let identity = describe_connection(&pending.target, &tokens.access, http)
        .await
        .map_err(CompleteSignInError::Identity)?;
    Ok(browser
        .signed_in(SignedIn {
            endpoint: KbEndpoint::Http(pending.target),
            description: identity.description,
            session: StoredSession {
                access: tokens.access,
                refresh: tokens.refresh,
                client_id: BROWSER_CLIENT_ID.to_owned(),
                token_endpoint: pending.issuer.token,
                revocation_endpoint: pending.issuer.revocation,
            },
            kb_id: pending.kb_id,
            expected_did: pending.expected_did,
            expected_name: pending.expected_name,
        })
        .await)
}
