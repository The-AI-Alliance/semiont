//! What knows how a knowledge base is reached: it builds the session of
//! one, and ends the credentials of one. A registry of knowledge bases is
//! given a factory, and so manages sessions over any transport without
//! knowing which.

use super::semiont_session::SemiontSession;
use super::signals::SessionSignals;
use super::stored::StoredSession;
use crate::errors::SessionError;
use crate::storage::SessionStorage;
use crate::transport::BoxFuture;
use crate::types::KnowledgeBase;
use std::sync::Arc;

pub struct SessionFactoryOptions {
    /// The knowledge base the session is for.
    pub kb: KnowledgeBase,
    /// The registry's own storage: its sign-in is kept there under the
    /// knowledge base's id (`super::kept_in`), and its client keeps what it
    /// keeps of the person there.
    pub storage: Arc<dyn SessionStorage>,
    /// Where the session says it is over, for a host to show.
    pub signals: Arc<SessionSignals>,
}

pub trait SessionFactory: Send + Sync + 'static {
    /// Build the session of a knowledge base, and the client it uses.
    /// Refused, with why, for a knowledge base this factory cannot reach.
    /// It reads nothing of what the session says: the registry is the one
    /// reader of its errors. The caller owns both: it closes the client,
    /// then ends the session.
    fn session(&self, options: SessionFactoryOptions) -> Result<SemiontSession, SessionError>;

    /// A stored session has been forgotten: tell whoever issued it, so its
    /// refresh token is good for nothing. Best effort: the sign-out has
    /// happened whether or not the issuer hears of it.
    fn revoke(&self, stored: StoredSession) -> BoxFuture<'static, ()>;
}
