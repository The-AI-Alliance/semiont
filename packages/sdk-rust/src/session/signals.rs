//! What a host shows about a session, apart from the session: that it
//! expired, that a request was refused for lack of permission, that a
//! different knowledge base is answering at a registered address.
//!
//! A session is headless and raises none of these itself. A host that shows
//! them builds one of these beside each live session and wires the session's
//! failures into it. Each signal is one value: none while nothing is raised,
//! the notice while something is. Raising it again is a new occurrence, told
//! to every reader even when the notice equals the last.
//!
//! A signal says and decides nothing. By the time a session is said to have
//! expired it has already cleared its token and what it stored.

use crate::state::Held;
use crate::state_unit::StateUnit;
use tokio::sync::watch;

/// A notice with a message, for a host to show until it is acknowledged.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionNotice {
    pub message: String,
}

/// What a registered entry said it was, and what answered. Both, because
/// neither alone can be acted on: a person has to recognise which knowledge
/// base they registered and which one is there now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KbIdentityConflict {
    pub expected_did: String,
    pub observed_did: String,
}

const EXPIRED: &str = "Your session has expired. Please sign in again.";
const DENIED: &str = "You do not have permission to perform this action.";

/// See the module's documentation.
pub struct SessionSignals {
    session_expired: Held<Option<SessionNotice>>,
    permission_denied: Held<Option<SessionNotice>>,
    kb_identity_conflict: Held<Option<KbIdentityConflict>>,
}

impl Default for SessionSignals {
    fn default() -> SessionSignals {
        SessionSignals {
            session_expired: Held::new(None),
            permission_denied: Held::new(None),
            kb_identity_conflict: Held::new(None),
        }
    }
}

impl SessionSignals {
    pub fn new() -> SessionSignals {
        SessionSignals::default()
    }

    /// The session ended and could not be renewed.
    pub fn session_expired(&self) -> watch::Receiver<Option<SessionNotice>> {
        self.session_expired.read()
    }

    /// A request was refused for lack of permission.
    pub fn permission_denied(&self) -> watch::Receiver<Option<SessionNotice>> {
        self.permission_denied.read()
    }

    /// A different knowledge base is answering at the entry's address.
    pub fn kb_identity_conflict(&self) -> watch::Receiver<Option<KbIdentityConflict>> {
        self.kb_identity_conflict.read()
    }

    pub fn notify_session_expired(&self, message: Option<&str>) {
        self.session_expired.raise(Some(SessionNotice {
            message: message.unwrap_or(EXPIRED).to_owned(),
        }));
    }

    pub fn notify_permission_denied(&self, message: Option<&str>) {
        self.permission_denied.raise(Some(SessionNotice {
            message: message.unwrap_or(DENIED).to_owned(),
        }));
    }

    pub fn notify_kb_identity_conflict(&self, conflict: KbIdentityConflict) {
        self.kb_identity_conflict.raise(Some(conflict));
    }

    pub fn acknowledge_session_expired(&self) {
        self.session_expired.raise(None);
    }

    pub fn acknowledge_permission_denied(&self) {
        self.permission_denied.raise(None);
    }

    pub fn acknowledge_kb_identity_conflict(&self) {
        self.kb_identity_conflict.raise(None);
    }
}

impl StateUnit for SessionSignals {
    fn dispose(&self) {
        self.session_expired.end();
        self.permission_denied.end();
        self.kb_identity_conflict.end();
    }
}

impl Drop for SessionSignals {
    fn drop(&mut self) {
        self.dispose();
    }
}
