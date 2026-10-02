//! What knows how a knowledge base is reached: it builds the session of
//! one, and ends the credentials of one. A registry of knowledge bases is
//! given a factory, and so manages sessions over any transport without
//! knowing which.

use super::knowledge_base::KnowledgeBase;
use super::semiont_session::{OnSessionError, SemiontSession};
use super::signals::SessionSignals;
use super::stored::StoredSession;
use crate::errors::SessionError;
use crate::storage::SessionStorage;
use crate::transport::BoxFuture;
use std::sync::Arc;

pub struct SessionFactoryOptions {
    /// The knowledge base the session is for.
    pub kb: KnowledgeBase,
    /// Where its tokens are kept: the registry's own storage.
    pub storage: Arc<dyn SessionStorage>,
    /// Where the session says it is over, for a host to show.
    pub signals: Arc<SessionSignals>,
    /// Told of each failure that makes the session unusable.
    pub on_error: OnSessionError,
}

pub trait SessionFactory: Send + Sync + 'static {
    /// Build the session of a knowledge base. Refused, with why, for a
    /// knowledge base this factory cannot reach.
    fn session(&self, options: SessionFactoryOptions) -> Result<SemiontSession, SessionError>;

    /// A stored session has been forgotten: tell whoever issued it, so its
    /// refresh token is good for nothing. Best effort: the sign-out has
    /// happened whether or not the issuer hears of it.
    fn revoke(&self, stored: StoredSession) -> BoxFuture<'static, ()>;
}
