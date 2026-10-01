//! The sign-ins `semiont login` keeps (specs/src/sign-in-store), as a
//! `SessionStorage`: one sign-in serves the launcher's verbs and an
//! application built on this SDK.
//!
//! The launcher keeps one sign-in per stack, under the stack's key (`local`,
//! `codespace:<owner>/<name>`). A session reaches one by using that key as
//! its knowledge base id: the session of the knowledge base `local` is the
//! launcher's entry `local`. Everything else a client keeps, and the session
//! of any knowledge base the launcher has no entry for, is kept in the
//! storage this one is built over.
//!
//! What is in the file was issued to the script client and is renewed as
//! it. A session issued to another client is kept in the storage beneath,
//! never in the file: the launcher would renew it as the wrong client. It
//! is then this application's session of that knowledge base, read before
//! the file's, and the launcher's entry is left as it was.
//!
//! **Every change is a read, a change and a write under a lock**
//! (`tokens.lock`, beside the file): another process renewing another stack
//! at the same moment loses nothing. What the file holds that is not a
//! sign-in as this release knows one is written back as it was.
//!
//! A file that cannot be read or written is said to `on_failure`, and the
//! store then behaves as if the file held nothing, or the write was not
//! made: a `SessionStorage` has no other way to say so.

use crate::locked;
use crate::session::{
    SCRIPT_CLIENT_ID, StoredSession, kb_of_session_key, text_claim, token_expiry,
};
use crate::storage::{SessionStorage, StorageChange, StorageSubscription};
use serde_json::{Map, Value};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

include!(concat!(env!("OUT_DIR"), "/sign_in.rs"));

/// The file's name in the launcher's state home.
pub const FILE_NAME: &str = "tokens.json";

/// The launcher's state home, from what the system says of the person's
/// directories (specs/src/sign-in-store/cases.json): `home` is the home
/// directory and `xdg_state_home` is `XDG_STATE_HOME`, each none when it is
/// not set. None when there is no home.
///
/// This crate reads no environment: a service links it, and what a service
/// reads of its environment is a contract. An application reads its own and
/// says what it found:
/// `state_dir(cfg!(target_os = "macos"), home, xdg_state_home)`.
pub fn state_dir(macos: bool, home: Option<&str>, xdg_state_home: Option<&str>) -> Option<PathBuf> {
    let home = home.filter(|home| !home.is_empty())?;
    Some(if macos {
        Path::new(home).join("Library/Application Support/semiont")
    } else {
        match xdg_state_home.filter(|state| !state.is_empty()) {
            Some(state) => Path::new(state).join("semiont"),
            None => Path::new(home).join(".local/state/semiont"),
        }
    })
}

/// A time as RFC 3339 in UTC, to the second.
fn rfc3339(at: SystemTime) -> String {
    let seconds = at
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_secs());
    let (days, of_day) = (seconds / 86_400, seconds % 86_400);
    // The civil date of a count of days since 1970-01-01, in the proleptic
    // Gregorian calendar, by eras of 400 years that begin on a March 1st.
    let shifted = days + 719_468;
    let (era, day_of_era) = (shifted / 146_097, shifted % 146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let shifted_month = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * shifted_month + 2) / 5 + 1;
    let month = if shifted_month < 10 {
        shifted_month + 3
    } else {
        shifted_month - 9
    };
    let year = year_of_era + era * 400 + u64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        of_day / 3_600,
        of_day % 3_600 / 60,
        of_day % 60
    )
}

/// A sign-in as the session a client holds: one with no refresh token is
/// none, because a session that cannot be renewed does not outlive its first
/// access token.
fn session_of(entry: &Value) -> Option<StoredSession> {
    let entry: SignIn = serde_json::from_value(entry.clone()).ok()?;
    Some(StoredSession {
        access: entry.token,
        refresh: entry.refresh_token.filter(|refresh| !refresh.is_empty())?,
        client_id: SCRIPT_CLIENT_ID.to_owned(),
        token_endpoint: entry.token_endpoint,
        revocation_endpoint: entry.revocation_endpoint,
    })
}

/// A session as the sign-in the file keeps. Renewing an entry keeps what
/// the sign-in learned and a renewal does not: who signed in, and at which
/// issuer. A new entry states them when its token does.
fn entry_of(session: &StoredSession, before: Option<&Value>, now: SystemTime) -> Value {
    let before: Option<SignIn> =
        before.and_then(|entry| serde_json::from_value(entry.clone()).ok());
    let (email, issuer) = match before {
        Some(before) => (before.email, before.issuer),
        None => (
            text_claim(&session.access, "email"),
            text_claim(&session.access, "iss"),
        ),
    };
    // A struct of strings always serializes to an object.
    serde_json::to_value(SignIn {
        token: session.access.clone(),
        refresh_token: Some(session.refresh.clone()),
        email,
        obtained_at: rfc3339(now),
        expires_at: token_expiry(&session.access).map(rfc3339),
        issuer,
        token_endpoint: session.token_endpoint.clone(),
        revocation_endpoint: session.revocation_endpoint.clone(),
    })
    .unwrap_or(Value::Null)
}

/// Told that the file could not be read or written, with why.
pub type OnFailure = Arc<dyn Fn(&str) + Send + Sync>;

/// See the module's documentation.
pub struct SignInStore {
    path: PathBuf,
    rest: Arc<dyn SessionStorage>,
    on_failure: OnFailure,
    /// One change at a time from this process: the file lock is between
    /// processes, and two handles of one process on one file do not exclude
    /// each other on every system.
    turn: Mutex<()>,
}

impl SignInStore {
    /// The store in the file at `path` (`FILE_NAME` in `state_dir`, for the
    /// launcher's), over `rest` for everything that is not one of its
    /// sign-ins.
    pub fn at(
        path: impl Into<PathBuf>,
        rest: Arc<dyn SessionStorage>,
        on_failure: OnFailure,
    ) -> SignInStore {
        SignInStore {
            path: path.into(),
            rest,
            on_failure,
            turn: Mutex::new(()),
        }
    }

    fn failed(&self, doing: &str, error: &io::Error) {
        (self.on_failure)(&format!("{doing} {}: {error}", self.path.display()));
    }

    /// The document as it is now. A file that is not there holds nothing.
    fn read(&self) -> io::Result<Map<String, Value>> {
        let text = match fs::read_to_string(&self.path) {
            Ok(text) => text,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Map::new()),
            Err(error) => return Err(error),
        };
        serde_json::from_str(&text)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
    }

    fn entry(&self, kb_id: &str) -> Option<Value> {
        match self.read() {
            Ok(mut document) => document.remove(kb_id),
            Err(error) => {
                self.failed("Could not read", &error);
                None
            }
        }
    }

    /// Change the document as one step: read it, change it, and write it
    /// when `change` says it changed, with the lock held throughout.
    fn change<T>(&self, change: impl FnOnce(&mut Map<String, Value>) -> (bool, T)) -> Option<T> {
        let _turn = locked(&self.turn);
        let changed = (|| -> io::Result<T> {
            if let Some(directory) = self.path.parent() {
                fs::create_dir_all(directory)?;
            }
            let lock = File::create(self.path.with_extension("lock"))?;
            lock.lock()?;
            let mut document = self.read()?;
            let (changed, answer) = change(&mut document);
            if changed {
                self.write(&document)?;
            }
            Ok(answer)
        })();
        match changed {
            Ok(answer) => Some(answer),
            Err(error) => {
                self.failed("Could not change", &error);
                None
            }
        }
    }

    /// Written beside the file and renamed over it: no reader sees half a
    /// document, and no credential is left in a stray file.
    fn write(&self, document: &Map<String, Value>) -> io::Result<()> {
        let mut text = serde_json::to_string_pretty(document)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
        text.push('\n');
        let beside = self.path.with_extension("json.tmp");
        let mut options = OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let written = options
            .open(&beside)
            .and_then(|mut file| file.write_all(text.as_bytes()))
            .and_then(|()| fs::rename(&beside, &self.path));
        if written.is_err() {
            let _ = fs::remove_file(&beside);
        }
        written
    }

    /// Put `next` under the session key of `kb_id`: a session of the script
    /// client in the file, any other value beneath it, and nothing in
    /// neither. `document` is the file's, held under the lock. Whether the
    /// document changed.
    fn put(
        &self,
        document: &mut Map<String, Value>,
        key: &str,
        kb_id: &str,
        next: Option<&str>,
    ) -> bool {
        match (next, next.and_then(StoredSession::read)) {
            (_, Some(session)) if session.client_id == SCRIPT_CLIENT_ID => {
                let entry = entry_of(&session, document.get(kb_id), SystemTime::now());
                document.insert(kb_id.to_owned(), entry);
                self.rest.delete(key);
                true
            }
            (Some(next), _) => {
                self.rest.set(key, next);
                false
            }
            (None, _) => {
                self.rest.delete(key);
                document.remove(kb_id).is_some()
            }
        }
    }
}

impl SessionStorage for SignInStore {
    fn get(&self, key: &str) -> Option<String> {
        self.rest.get(key).or_else(|| {
            let entry = self.entry(kb_of_session_key(key)?)?;
            Some(session_of(&entry)?.written())
        })
    }

    fn set(&self, key: &str, value: &str) {
        match kb_of_session_key(key) {
            Some(kb_id) => {
                self.change(|document| (self.put(document, key, kb_id, Some(value)), ()));
            }
            None => self.rest.set(key, value),
        }
    }

    fn delete(&self, key: &str) {
        match kb_of_session_key(key) {
            Some(kb_id) => {
                self.change(|document| (self.put(document, key, kb_id, None), ()));
            }
            None => self.rest.delete(key),
        }
    }

    fn update(&self, key: &str, change: &mut dyn FnMut(Option<&str>) -> Option<String>) {
        let Some(kb_id) = kb_of_session_key(key) else {
            return self.rest.update(key, change);
        };
        self.change(|document| {
            let current = self.rest.get(key).or_else(|| {
                document
                    .get(kb_id)
                    .and_then(session_of)
                    .map(|session| session.written())
            });
            let next = change(current.as_deref());
            if next == current {
                return (false, ());
            }
            (self.put(document, key, kb_id, next.as_deref()), ())
        });
    }

    /// What another context writes to the storage beneath. The file is not
    /// watched: what another process renewed is read the next time this
    /// one renews.
    fn subscribe(&self, on_change: StorageChange) -> Option<StorageSubscription> {
        self.rest.subscribe(on_change)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn a_time_is_written_as_rfc_3339_in_utc() {
        let at = |seconds: u64| rfc3339(UNIX_EPOCH + Duration::from_secs(seconds));
        assert_eq!(at(0), "1970-01-01T00:00:00Z");
        assert_eq!(at(951_782_400), "2000-02-29T00:00:00Z");
        assert_eq!(at(1_790_869_830), "2026-10-01T15:50:30Z");
        assert_eq!(at(4_102_444_799), "2099-12-31T23:59:59Z");
    }
}
