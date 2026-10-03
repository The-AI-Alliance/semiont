//! What a host shows about a session, apart from the session: that it
//! ended, that a request was refused for lack of permission, that a
//! different knowledge base is answering at a registered address.
//!
//! A session is headless and raises none of these itself. A host that shows
//! them builds one of these beside each live session and wires the session's
//! failures into it. Each signal is one value: none while nothing is raised,
//! the notice while something is. Raising it again is a new occurrence, told
//! to every reader even when the notice equals the last.
//!
//! A signal says and decides nothing. By the time a session is said to have
//! ended it has already cleared its token and what it stored.
//!
//! A notice says what happened, never a sentence: what a person reads is the
//! host's to write, in their language.

use crate::state::Held;
use crate::state_unit::StateUnit;
use tokio::sync::watch;

/// Why a session ended: its token could not be renewed (`Expired`), or the
/// gateway refused a token its issuer had just issued (`Refused`). The
/// vocabulary is specs/src/session/cases.json's `told`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionEndReason {
    Expired,
    Refused,
}

impl SessionEndReason {
    /// The reason as specs/src/session/cases.json names it.
    pub fn as_str(self) -> &'static str {
        match self {
            SessionEndReason::Expired => "expired",
            SessionEndReason::Refused => "refused",
        }
    }
}

/// A session ended, and why.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionEnded {
    pub reason: SessionEndReason,
}

/// A request was refused for lack of permission. `detail` is the refusal's
/// own message, untranslated; none when there is none.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PermissionDenied {
    pub detail: Option<String>,
}

/// What a registered entry said it was, and what answered. Both, because
/// neither alone can be acted on: a person has to recognise which knowledge
/// base they registered and which one is there now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KbIdentityConflict {
    pub expected_did: String,
    pub observed_did: String,
}

/// See the module's documentation.
pub struct SessionSignals {
    session_ended: Held<Option<SessionEnded>>,
    permission_denied: Held<Option<PermissionDenied>>,
    kb_identity_conflict: Held<Option<KbIdentityConflict>>,
}

impl Default for SessionSignals {
    fn default() -> SessionSignals {
        SessionSignals {
            session_ended: Held::new(None),
            permission_denied: Held::new(None),
            kb_identity_conflict: Held::new(None),
        }
    }
}

impl SessionSignals {
    pub fn new() -> SessionSignals {
        SessionSignals::default()
    }

    /// The session ended: it expired, or its credential was refused.
    pub fn session_ended(&self) -> watch::Receiver<Option<SessionEnded>> {
        self.session_ended.read()
    }

    /// A request was refused for lack of permission.
    pub fn permission_denied(&self) -> watch::Receiver<Option<PermissionDenied>> {
        self.permission_denied.read()
    }

    /// A different knowledge base is answering at the entry's address.
    pub fn kb_identity_conflict(&self) -> watch::Receiver<Option<KbIdentityConflict>> {
        self.kb_identity_conflict.read()
    }

    pub fn notify_session_ended(&self, reason: SessionEndReason) {
        self.session_ended.raise(Some(SessionEnded { reason }));
    }

    pub fn notify_permission_denied(&self, detail: Option<&str>) {
        self.permission_denied.raise(Some(PermissionDenied {
            detail: detail.map(str::to_owned),
        }));
    }

    pub fn notify_kb_identity_conflict(&self, conflict: KbIdentityConflict) {
        self.kb_identity_conflict.raise(Some(conflict));
    }

    pub fn acknowledge_session_ended(&self) {
        self.session_ended.raise(None);
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
        self.session_ended.end();
        self.permission_denied.end();
        self.kb_identity_conflict.end();
    }
}

impl Drop for SessionSignals {
    fn drop(&mut self) {
        self.dispose();
    }
}
