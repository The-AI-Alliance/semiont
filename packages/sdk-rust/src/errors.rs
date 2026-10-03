//! What a client reports when something fails, under the codes every SDK
//! shares (specs/src/errors/codes.json, generated here): a transport's failure,
//! which is a server's refusal or a request the gateway never answered; a bus
//! request's, which is the peer's own failure or a fact only this side knows;
//! a followed job's, which failed for good or went silent; and the three
//! together, as a caller meets them. Beside them, what makes a session
//! unusable, and what keeps a person from being signed in.

use crate::types::JobId;
use serde_json::{Map, Value};
use std::fmt;
use std::time::Duration;

include!(concat!(env!("OUT_DIR"), "/error_codes.rs"));

/// A transport's failure. A server that answered states a status, and the
/// status decides the code; an exchange that ended with no answer has none,
/// and whoever saw it end says which ending it was.
#[derive(Debug, Clone, PartialEq)]
pub struct TransportError {
    pub code: TransportErrorCode,
    /// The HTTP status, when a server stated one.
    pub status: Option<u16>,
    pub message: String,
    /// The gateway's own words (`ErrorResponse.error`), when its body stated
    /// them; none when it did not, or when what answered was not the
    /// gateway's error body. Kept apart from `message`, which falls back to
    /// the status: a host that shows a person what the gateway said must
    /// never show them a sentence the transport made up.
    pub said: Option<String>,
    /// The wait the refusal's `Retry-After` stated.
    pub retry_after: Option<Duration>,
}

impl TransportError {
    /// The server answered, and its status decides the code.
    pub fn of_status(
        message: impl Into<String>,
        status: u16,
        retry_after: Option<Duration>,
    ) -> TransportError {
        TransportError {
            code: TransportErrorCode::of_status(status),
            status: Some(status),
            message: message.into(),
            said: None,
            retry_after,
        }
    }

    /// The gateway's refusal, as every request reports one: in the gateway's
    /// own words when its body states them (`ErrorResponse.error`), and with
    /// the wait its `Retry-After` states.
    pub fn refusal(status: u16, said: Option<String>, retry_after: Option<Duration>) -> TransportError {
        TransportError {
            code: TransportErrorCode::of_status(status),
            status: Some(status),
            message: said.clone().unwrap_or_else(|| format!("HTTP {status}")),
            said,
            retry_after,
        }
    }

    /// The exchange ended with no response.
    pub fn without_response(
        message: impl Into<String>,
        code: TransportErrorCode,
    ) -> TransportError {
        TransportError {
            code,
            status: None,
            message: message.into(),
            said: None,
            retry_after: None,
        }
    }
}

impl fmt::Display for TransportError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for TransportError {}

/// Why a bus request did not resolve.
#[derive(Debug, Clone, PartialEq)]
pub struct BusRequestError {
    pub code: BusRequestErrorCode,
    pub message: String,
    /// The failure the peer answered with (a `CommandError`), when it answered one.
    pub failure: Option<Map<String, Value>>,
}

impl BusRequestError {
    pub fn new(code: BusRequestErrorCode, message: impl Into<String>) -> BusRequestError {
        BusRequestError {
            code,
            message: message.into(),
            failure: None,
        }
    }
}

impl fmt::Display for BusRequestError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for BusRequestError {}

/// Why a job its client was following ended without a result.
#[derive(Debug, Clone, PartialEq)]
pub struct JobError {
    pub code: JobErrorCode,
    /// The job, once its id is known: a job that stalled before it was
    /// created has none.
    pub job_id: Option<JobId>,
    pub message: String,
}

impl fmt::Display for JobError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for JobError {}

/// A session that is itself unusable: it could not be built, its stored
/// credential could not be validated, or it could not be renewed. What one
/// request met stays with whoever made it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionError {
    pub code: SessionErrorCode,
    pub message: String,
    /// The knowledge base the session was for.
    pub kb_id: Option<String>,
}

impl SessionError {
    pub fn new(code: SessionErrorCode, message: impl Into<String>, kb_id: &str) -> SessionError {
        SessionError {
            code,
            message: message.into(),
            kb_id: Some(kb_id.to_owned()),
        }
    }
}

impl fmt::Display for SessionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for SessionError {}

/// Why a person could not be signed in at the issuer a knowledge base
/// trusts, or a session could not be renewed there.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignInError {
    pub code: SignInErrorCode,
    pub message: String,
    /// The HTTP status the issuer answered with. None when there was no
    /// answer to read, which is not the issuer refusing: a renewal that got
    /// none is worth another attempt, and one that was refused is not.
    pub status: Option<u16>,
}

impl SignInError {
    pub fn new(code: SignInErrorCode, message: impl Into<String>) -> SignInError {
        SignInError {
            code,
            message: message.into(),
            status: None,
        }
    }

    pub fn answered(code: SignInErrorCode, message: impl Into<String>, status: u16) -> SignInError {
        SignInError {
            code,
            message: message.into(),
            status: Some(status),
        }
    }
}

impl fmt::Display for SignInError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for SignInError {}

/// A sign-in succeeded, and the knowledge base it reached could not be
/// registered: it has to say who it is, and nothing stands in for its
/// answer. An identity made up from its address is the error this exists to
/// prevent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IdentityUnverifiable {
    pub reason: IdentityUnverifiableReason,
    pub detail: String,
}

impl fmt::Display for IdentityUnverifiable {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.detail)
    }
}

impl std::error::Error for IdentityUnverifiable {}

/// What a caller meets: a request's own failure, the transport's failure to
/// send it, or the failure of a job it was following.
#[derive(Debug, Clone, PartialEq)]
pub enum SemiontError {
    Bus(BusRequestError),
    Transport(TransportError),
    Job(JobError),
}

impl SemiontError {
    /// The code, as specs/src/errors/codes.json lists it.
    pub fn code(&self) -> &'static str {
        match self {
            SemiontError::Bus(error) => error.code.as_str(),
            SemiontError::Transport(error) => error.code.as_str(),
            SemiontError::Job(error) => error.code.as_str(),
        }
    }

    /// The HTTP status, when a server stated one.
    pub fn status(&self) -> Option<u16> {
        match self {
            SemiontError::Bus(_) | SemiontError::Job(_) => None,
            SemiontError::Transport(error) => error.status,
        }
    }
}

impl fmt::Display for SemiontError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SemiontError::Bus(error) => error.fmt(f),
            SemiontError::Transport(error) => error.fmt(f),
            SemiontError::Job(error) => error.fmt(f),
        }
    }
}

impl std::error::Error for SemiontError {}

impl From<JobError> for SemiontError {
    fn from(error: JobError) -> SemiontError {
        SemiontError::Job(error)
    }
}

impl From<BusRequestError> for SemiontError {
    fn from(error: BusRequestError) -> SemiontError {
        SemiontError::Bus(error)
    }
}

impl From<TransportError> for SemiontError {
    fn from(error: TransportError) -> SemiontError {
        SemiontError::Transport(error)
    }
}

/// The wire code a failed request's peer stated, for a service that answers
/// its own caller with that failure: `peer-unavailable` from a read it
/// depended on reaches the caller as `peer-unavailable`. A failure only this
/// side knows — a timeout, a closed bus, an emit the gateway refused — states
/// none.
pub fn relayed_failure_code(error: &SemiontError) -> Option<crate::types::CommandErrorCode> {
    match error {
        SemiontError::Bus(error) => error.code.wire(),
        SemiontError::Transport(_) | SemiontError::Job(_) => None,
    }
}
