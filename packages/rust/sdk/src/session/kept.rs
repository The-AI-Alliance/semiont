//! Where one knowledge base's sign-in is kept (`SignInKept`): what a
//! session is built from, renews through and forgets. A registry keeps its
//! sign-ins in its storage (`super::kept_in`), `semiont login` in its file
//! (`crate::sign_in_store::SignInStore::entry`), and a script that keeps
//! nothing past its process in memory (`MemorySignIn`).

use super::stored::StoredSession;
use crate::locked;
use crate::transport::BoxFuture;
use std::error::Error;
use std::sync::Mutex;

/// Where one knowledge base's sign-in is kept. What it cannot read or write
/// is its error.
pub trait SignInKept: Send + Sync + 'static {
    /// The sign-in as it is kept now; none when there is none.
    fn held(&self) -> BoxFuture<'_, Result<Option<StoredSession>, Box<dyn Error + Send + Sync>>>;

    /// Keep `sign_in`, a new sign-in, in place of whatever was kept.
    fn keep(
        &self,
        sign_in: StoredSession,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>>;

    /// Keep the tokens a renewal of `read` issued, `access` and `refresh`,
    /// against what is kept now, and give the access token kept then. When
    /// what is kept no longer holds `read`'s tokens, it was renewed some
    /// other way meanwhile, or signed in again: that stands, and its access
    /// token is the one given. None when nothing is kept: a sign-in that was
    /// signed out, or ended, while it was being renewed is gone, and is not
    /// written back. A renewal keeps the person the sign-in names.
    fn renewed<'a>(
        &'a self,
        read: &'a StoredSession,
        access: &'a str,
        refresh: &'a str,
    ) -> BoxFuture<'a, Result<Option<String>, Box<dyn Error + Send + Sync>>>;

    /// Record `person_key`, the key of the person the gateway said `access`
    /// is, on the sign-in kept now, as one step: only while it holds
    /// `access` and names no person. Whether the sign-in kept names
    /// `person_key` afterwards: false when it holds another token, or none,
    /// or names another person, and for a keeper that keeps no person. It
    /// is how a session keys what its client keeps by the person.
    fn record_person_key<'a>(
        &'a self,
        access: &'a str,
        person_key: &'a str,
    ) -> BoxFuture<'a, Result<bool, Box<dyn Error + Send + Sync>>>;

    /// Keep the sign-in no more.
    fn forget(&self) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>>;
}

/// A sign-in kept for as long as the process lives, and no longer.
#[derive(Default)]
pub struct MemorySignIn {
    kept: Mutex<Option<StoredSession>>,
}

impl MemorySignIn {
    /// One that keeps nothing yet.
    pub fn new() -> MemorySignIn {
        MemorySignIn::default()
    }
}

impl SignInKept for MemorySignIn {
    fn held(&self) -> BoxFuture<'_, Result<Option<StoredSession>, Box<dyn Error + Send + Sync>>> {
        Box::pin(async move { Ok(locked(&self.kept).clone()) })
    }

    fn keep(
        &self,
        sign_in: StoredSession,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        Box::pin(async move {
            *locked(&self.kept) = Some(sign_in);
            Ok(())
        })
    }

    fn renewed<'a>(
        &'a self,
        read: &'a StoredSession,
        access: &'a str,
        refresh: &'a str,
    ) -> BoxFuture<'a, Result<Option<String>, Box<dyn Error + Send + Sync>>> {
        Box::pin(async move {
            let mut kept = locked(&self.kept);
            let Some(held) = kept.as_mut() else {
                return Ok(None);
            };
            if held.access != read.access || held.refresh != read.refresh {
                return Ok(Some(held.access.clone()));
            }
            held.access = access.to_owned();
            held.refresh = refresh.to_owned();
            Ok(Some(access.to_owned()))
        })
    }

    fn record_person_key<'a>(
        &'a self,
        access: &'a str,
        person_key: &'a str,
    ) -> BoxFuture<'a, Result<bool, Box<dyn Error + Send + Sync>>> {
        Box::pin(async move {
            let mut kept = locked(&self.kept);
            let Some(held) = kept.as_mut().filter(|held| held.access == access) else {
                return Ok(false);
            };
            let named = held.person_key.get_or_insert_with(|| person_key.to_owned());
            Ok(*named == person_key)
        })
    }

    fn forget(&self) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        Box::pin(async move {
            *locked(&self.kept) = None;
            Ok(())
        })
    }
}
