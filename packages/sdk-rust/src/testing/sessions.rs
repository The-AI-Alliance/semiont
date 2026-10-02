//! A `SessionFactory` for tests of a registry (`SemiontBrowser`) and of what
//! is built on one. Each session it builds is a real `SemiontSession` over a
//! `FaultyTransport` of its own, and the factory keeps every transport it
//! built, by knowledge base.
//!
//! A test scripts three things: what each knowledge base's gateway answers,
//! who the gateway says a token is, and what a renewal gives. Each refuses
//! by name until it is scripted: an unscripted request names its operation
//! and its knowledge base, an unscripted renewal is a renewal that failed,
//! and a gateway nobody scripted a user for cannot say who a token is.

use super::{FaultyTransport, TestClientOptions, create_test_client};
use crate::errors::{
    SemiontError, SessionError, SessionErrorCode, TransportError, TransportErrorCode,
};
use crate::locked;
use crate::session::{
    SemiontSession, SemiontSessionConfig, SessionFactory, SessionFactoryOptions, StoredSession,
};
use crate::transport::BoxFuture;
use crate::types::UserResponse;
use serde_json::{Map, Value};
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::watch;

/// What a knowledge base's gateway answers a request with: its `response`,
/// `None` for a reply that carries none, or a refusal with why. Given the
/// knowledge base's id, the operation and the payload.
pub type Answer =
    dyn Fn(&str, &str, &Map<String, Value>) -> Result<Option<Value>, String> + Send + Sync;

/// The failure a knowledge base's gateway answers a request with, when it
/// answers it with one: the payload of the operation's failure channel.
pub type Refusal = dyn Fn(&str, &str, &Map<String, Value>) -> Option<Value> + Send + Sync;

#[derive(Default)]
struct Scripted {
    refuse: Option<Arc<Refusal>>,
    refuses_to_build: Option<String>,
    user: Option<UserResponse>,
    answers_after: Duration,
    renewals: VecDeque<Result<Option<String>, String>>,
    renewed: usize,
    built: Vec<(String, FaultyTransport)>,
    revoked: Vec<StoredSession>,
}

struct Inner {
    answer: Arc<Answer>,
    scripted: Mutex<Scripted>,
}

/// See the module's documentation.
#[derive(Clone)]
pub struct ScriptedSessions {
    inner: Arc<Inner>,
}

impl Default for ScriptedSessions {
    fn default() -> ScriptedSessions {
        ScriptedSessions::new()
    }
}

impl ScriptedSessions {
    /// Sessions of knowledge bases that answer nothing: every request is
    /// refused, naming its operation and its knowledge base.
    pub fn new() -> ScriptedSessions {
        ScriptedSessions::answering(|kb_id, operation, _| {
            Err(format!(
                "No response scripted for \"{operation}\" of knowledge base \"{kb_id}\". Build the factory with ScriptedSessions::answering."
            ))
        })
    }

    /// Sessions of knowledge bases whose gateways answer as `answer` says.
    pub fn answering(
        answer: impl Fn(&str, &str, &Map<String, Value>) -> Result<Option<Value>, String>
        + Send
        + Sync
        + 'static,
    ) -> ScriptedSessions {
        ScriptedSessions {
            inner: Arc::new(Inner {
                answer: Arc::new(answer),
                scripted: Mutex::new(Scripted::default()),
            }),
        }
    }

    /// Have a gateway answer with a failure every request `refuse` gives
    /// one for, before it is asked for an answer. Sessions already built
    /// refuse so too.
    pub fn refuse_when(
        &self,
        refuse: impl Fn(&str, &str, &Map<String, Value>) -> Option<Value> + Send + Sync + 'static,
    ) {
        locked(&self.inner.scripted).refuse = Some(Arc::new(refuse));
    }

    /// Refuse to build any session, with this to say; `None` builds again.
    pub fn refuse_to_build(&self, why: Option<&str>) {
        locked(&self.inner.scripted).refuses_to_build = why.map(str::to_owned);
    }

    /// Who the gateway says a token is, of every session built from now.
    pub fn says_who(&self, user: UserResponse) {
        locked(&self.inner.scripted).user = Some(user);
    }

    /// How long the gateway takes to say who a token is, of every session
    /// built from now.
    pub fn answers_after(&self, wait: Duration) {
        locked(&self.inner.scripted).answers_after = wait;
    }

    /// What the next renewals give, one each, in order: a token, `None`
    /// for a session that has nothing to renew with, or why it failed.
    pub fn queue_renewals(
        &self,
        renewals: impl IntoIterator<Item = Result<Option<String>, String>>,
    ) {
        locked(&self.inner.scripted).renewals.extend(renewals);
    }

    /// How many renewals were asked for.
    pub fn renewed(&self) -> usize {
        locked(&self.inner.scripted).renewed
    }

    /// The transports of the sessions built for a knowledge base, in the
    /// order they were built.
    pub fn transports(&self, kb_id: &str) -> Vec<FaultyTransport> {
        locked(&self.inner.scripted)
            .built
            .iter()
            .filter(|(built_for, _)| built_for == kb_id)
            .map(|(_, transport)| transport.clone())
            .collect()
    }

    /// Every stored session the factory was told to revoke, in order.
    pub fn revoked(&self) -> Vec<StoredSession> {
        locked(&self.inner.scripted).revoked.clone()
    }
}

impl SessionFactory for ScriptedSessions {
    fn session(&self, options: SessionFactoryOptions) -> Result<SemiontSession, SessionError> {
        let kb_id = options.kb.id.clone();
        if let Some(why) = locked(&self.inner.scripted).refuses_to_build.clone() {
            return Err(SessionError::new(
                SessionErrorCode::ConstructFailed,
                why,
                &kb_id,
            ));
        }

        let (answering, answers_for) = (self.inner.clone(), kb_id.clone());
        let transport = FaultyTransport::answering(vec![], move |operation, payload| {
            (answering.answer)(&answers_for, operation, payload)
        });
        let (refusing, refuses_for) = (self.inner.clone(), kb_id.clone());
        transport.refuse_when(move |operation, payload| {
            let refuse = locked(&refusing.scripted).refuse.clone()?;
            refuse(&refuses_for, operation, payload)
        });
        let client = create_test_client(TestClientOptions {
            transport: Some(transport.clone()),
            ..TestClientOptions::default()
        })
        .client;

        let (user, answers_after) = {
            let mut scripted = locked(&self.inner.scripted);
            scripted.built.push((kb_id.clone(), transport));
            (scripted.user.clone(), scripted.answers_after)
        };
        let (renewing, renews_for) = (self.inner.clone(), kb_id.clone());
        let signals = options.signals;
        Ok(SemiontSession::new(SemiontSessionConfig {
            kb: options.kb.target(),
            storage: options.storage,
            client,
            token: watch::channel(None).0,
            refresh: Some(Arc::new(move || {
                let answer = {
                    let mut scripted = locked(&renewing.scripted);
                    scripted.renewed += 1;
                    scripted.renewals.pop_front().unwrap_or_else(|| {
                        Err(format!(
                            "ScriptedSessions: not scripted: a renewal of \"{renews_for}\". Script one with queue_renewals."
                        ))
                    })
                };
                Box::pin(async move { answer })
            })),
            validate: Some(Arc::new(move |_| {
                let answer = user.clone().ok_or_else(|| {
                    SemiontError::Transport(TransportError::without_response(
                        format!(
                            "ScriptedSessions: not scripted: who a token of \"{kb_id}\" is. Script it with says_who."
                        ),
                        TransportErrorCode::Error,
                    ))
                });
                Box::pin(async move {
                    tokio::time::sleep(answers_after).await;
                    answer
                })
            })),
            on_auth_failed: Some(Arc::new(move |message| {
                signals.notify_session_expired(Some(message));
            })),
            on_error: Some(options.on_error),
        }))
    }

    fn revoke(&self, stored: StoredSession) -> BoxFuture<'static, ()> {
        let inner = self.inner.clone();
        Box::pin(async move { locked(&inner.scripted).revoked.push(stored) })
    }
}
