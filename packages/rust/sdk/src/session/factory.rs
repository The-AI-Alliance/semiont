//! What knows how a knowledge base is reached: it builds the session of
//! one, and ends the credentials of one. A registry of knowledge bases is
//! given a factory, and so manages sessions over any transport without
//! knowing which.

use super::semiont_session::{OnSessionError, SemiontSession};
use super::signals::SessionSignals;
use super::stored::StoredSession;
use crate::errors::{SemiontError, SessionError, TransportErrorCode};
use crate::storage::SessionStorage;
use crate::transport::BoxFuture;
use crate::types::KnowledgeBase;
use std::sync::Arc;
use tokio::task::JoinSet;

pub struct SessionFactoryOptions {
    /// The knowledge base the session is for.
    pub kb: KnowledgeBase,
    /// The registry's own storage: its sign-in is kept there under the
    /// knowledge base's id (`super::kept_in`), and its client keeps what it
    /// keeps of the person there.
    pub storage: Arc<dyn SessionStorage>,
    /// Where the session says it is over, for a host to show.
    pub signals: Arc<SessionSignals>,
    /// Told of what the session says of its own on its errors stream, each
    /// once (`tell_registry`): each failure that makes it unusable, and
    /// what goes wrong with what its client keeps, which the session
    /// outlives.
    pub on_error: OnSessionError,
}

pub trait SessionFactory: Send + Sync + 'static {
    /// Build the session of a knowledge base, and the client it uses, and
    /// tell the registry what the session says (`tell_registry`). Refused,
    /// with why, for a knowledge base this factory cannot reach. The caller
    /// owns both: it closes the client, then ends the session.
    fn session(&self, options: SessionFactoryOptions) -> Result<SemiontSession, SessionError>;

    /// A stored session has been forgotten: tell whoever issued it, so its
    /// refresh token is good for nothing. Best effort: the sign-out has
    /// happened whether or not the issuer hears of it.
    fn revoke(&self, stored: StoredSession) -> BoxFuture<'static, ()>;
}

/// Tell a registry what `session` says, read from its errors, from the first
/// thing said, until they end: each of its own errors to `on_error`; a
/// refusal for want of a valid token renews the session, which heals
/// quietly, or ends itself and says so once; and a refusal for lack of
/// permission, which has no remedy, to `signals` as a permission denied.
/// What a factory does with each session it builds, as it builds it, inside
/// a Tokio runtime: it is the session's one reader, so nothing said at its
/// start is missed.
pub fn tell_registry(
    session: &SemiontSession,
    on_error: OnSessionError,
    signals: Arc<SessionSignals>,
) {
    let mut errors = session.errors();
    let (renewer, token) = (session.renewer(), session.token());
    tokio::spawn(async move {
        let mut renewing = JoinSet::new();
        while let Some(said) = errors.next().await {
            // What was missed is not known, and is not acted on.
            let Ok(said) = said else { continue };
            while renewing.try_join_next().is_some() {}
            match said {
                SemiontError::Session(error) => on_error(error),
                SemiontError::Transport(failure) => match failure.code {
                    TransportErrorCode::Unauthorized => {
                        // A failure does not say which token was refused:
                        // the one the session holds as it is read is.
                        let refused = token.borrow().clone();
                        let renewer = renewer.clone();
                        renewing.spawn(async move {
                            renewer.refresh(refused.as_deref()).await;
                        });
                    }
                    TransportErrorCode::Forbidden => {
                        signals.notify_permission_denied(Some(&failure.message));
                    }
                    _ => {}
                },
                SemiontError::Bus(_) | SemiontError::Job(_) => {}
            }
        }
    });
}
