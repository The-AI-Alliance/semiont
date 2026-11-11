//! The sign-ins `semiont login` keeps (protocol/specs/src/sign-in-store):
//! one sign-in serves the launcher's verbs and an application built on this
//! SDK.
//!
//! The launcher keeps one sign-in per stack, under the stack's key (`local`,
//! `codespace:<owner>/<name>`). An application reaches one as a sign-in kept
//! (`SignInStore::entry`), and builds a session from it with that key as its
//! knowledge base's id.
//!
//! What is in the file was issued to the script client and is renewed as
//! it: a sign-in issued to another client is not kept there, since the
//! launcher would renew it as the wrong client.
//!
//! **A sign-in kept is a new sign-in** (`SignInKept::keep`), and its entry
//! states who signed in and at which issuer as its own access token names
//! them, whoever the entry before it was of. **A renewal** (`renewed`)
//! keeps both as the sign-in learned them, whatever the renewed token names.
//!
//! **Every change is a read, a change and a write under a lock**
//! (`tokens.lock`, beside the file): another process renewing another stack
//! at the same moment loses nothing. What the file holds that is not a
//! sign-in as this release knows one is written back as it was. Under the
//! lock, the file's directory is kept to its owner, as the launcher keeps its
//! state home: the mode, and on Windows the access list, which what is made in
//! it inherits, that protocol/specs/src/sign-in-store/owner-only.json states.
//! The file is read and written off the runtime's threads.
//!
//! A file that cannot be read or written is the error of what was asked of
//! it, and the file is left as it was. So is a sign-in whose access token
//! does not say who issued it: the file states that of every sign-in, and
//! nothing is made up for one.

use crate::errors::{SignInError, SignInErrorCode};
use crate::locked;
use crate::rfc3339;
use crate::session::{SCRIPT_CLIENT_ID, SignInKept, StoredSession, text_claim, token_expiry};
use crate::transport::BoxFuture;
use serde_json::{Map, Value};
use std::error::Error;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

include!(concat!(env!("OUT_DIR"), "/sign_in.rs"));
include!(concat!(env!("OUT_DIR"), "/owner_only.rs"));

/// The file's name in the launcher's state home.
pub const FILE_NAME: &str = "tokens.json";

/// Keep `directory`, and everything made in it from then on, to its owner,
/// with the sign-in store's access list, which the launcher gives its state
/// home too. A mode keeps nobody out on Windows; the access list is what does. A
/// directory that has the list already is left as it is: setting a list
/// hands it down to everything beneath, which in a state home is no small
/// walk. The two lists are compared as Windows writes each out, which names
/// some users by an abbreviation (the built-in administrator is `LA`) rather
/// than by their SID, and with their entries in any order.
#[cfg(windows)]
#[allow(unsafe_code)]
fn owner_only(directory: &Path) -> io::Result<()> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::Foundation::{HANDLE, LocalFree};
    use windows_sys::Win32::Security::Authorization::{
        ConvertSecurityDescriptorToStringSecurityDescriptorW, ConvertSidToStringSidW,
        ConvertStringSecurityDescriptorToSecurityDescriptorW, GetNamedSecurityInfoW,
        SDDL_REVISION_1, SE_FILE_OBJECT, SetNamedSecurityInfoW,
    };
    use windows_sys::Win32::Security::{
        ACL, DACL_SECURITY_INFORMATION, GetSecurityDescriptorDacl, GetTokenInformation,
        PROTECTED_DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, TOKEN_USER, TokenUser,
    };

    /// This process's token, as `GetCurrentProcessToken` names it.
    const CURRENT_PROCESS_TOKEN: HANDLE = -4isize as HANDLE;
    let wide = |text: &OsStr| text.encode_wide().chain([0]).collect::<Vec<u16>>();

    // SAFETY: each buffer handed to the system is as large as the system says
    // it needs, each pointer it hands back is read only up to the terminator
    // it writes, and what it allocates is freed once, after its last use.
    unsafe {
        /// Text the system wrote and allocated, taken and freed.
        unsafe fn taken(text: *mut u16) -> String {
            // SAFETY: the system wrote the text and its terminator.
            let length = (0..)
                .take_while(|&at| unsafe { *text.add(at) } != 0)
                .count();
            // SAFETY: as above, and the text is freed once, here.
            unsafe {
                let taken = String::from_utf16_lossy(std::slice::from_raw_parts(text, length));
                LocalFree(text.cast());
                taken
            }
        }

        /// The access list `descriptor` holds, as Windows writes it out (SDDL).
        unsafe fn written(descriptor: PSECURITY_DESCRIPTOR) -> io::Result<String> {
            let mut text = null_mut();
            // SAFETY: the descriptor is one the system made, and the text it
            // writes out is taken once.
            unsafe {
                if ConvertSecurityDescriptorToStringSecurityDescriptorW(
                    descriptor,
                    SDDL_REVISION_1,
                    DACL_SECURITY_INFORMATION,
                    &mut text,
                    null_mut(),
                ) == 0
                {
                    return Err(io::Error::last_os_error());
                }
                Ok(taken(text))
            }
        }

        /// An access list as Windows writes it out, with its entries sorted:
        /// entries that each allow mean the same in any order, and a list's
        /// own entries need not be read back in the order they were set.
        fn in_any_order(list: &str) -> String {
            let (flags, entries) = match list.find('(') {
                Some(at) => list.split_at(at),
                None => (list, ""),
            };
            let mut entries: Vec<&str> = entries.split_inclusive(')').collect();
            entries.sort_unstable();
            format!("{flags}{}", entries.concat())
        }

        let mut size = 0u32;
        GetTokenInformation(CURRENT_PROCESS_TOKEN, TokenUser, null_mut(), 0, &mut size);
        // Aligned as a TOKEN_USER is: the SID it points to follows it.
        let mut user = vec![0u64; (size as usize).div_ceil(8)];
        if GetTokenInformation(
            CURRENT_PROCESS_TOKEN,
            TokenUser,
            user.as_mut_ptr().cast(),
            size,
            &mut size,
        ) == 0
        {
            return Err(io::Error::last_os_error());
        }
        let mut named = null_mut();
        if ConvertSidToStringSidW((*user.as_ptr().cast::<TOKEN_USER>()).User.Sid, &mut named) == 0 {
            return Err(io::Error::last_os_error());
        }
        let sddl = wide(OsStr::new(&owner_only_access_list(&taken(named))));
        let mut descriptor: PSECURITY_DESCRIPTOR = null_mut();
        if ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            SDDL_REVISION_1,
            &mut descriptor,
            null_mut(),
        ) == 0
        {
            return Err(io::Error::last_os_error());
        }

        let name = wide(directory.as_os_str());
        let kept = (|| {
            let (mut dacl, mut held): (*mut ACL, PSECURITY_DESCRIPTOR) = (null_mut(), null_mut());
            let failed = GetNamedSecurityInfoW(
                name.as_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                &mut dacl,
                null_mut(),
                &mut held,
            );
            if failed != 0 {
                return Err(io::Error::from_raw_os_error(failed as i32));
            }
            let has = written(held);
            LocalFree(held);
            if in_any_order(&has?) == in_any_order(&written(descriptor)?) {
                return Ok(());
            }
            let (mut present, mut defaulted) = (0, 0);
            if GetSecurityDescriptorDacl(descriptor, &mut present, &mut dacl, &mut defaulted) == 0 {
                return Err(io::Error::last_os_error());
            }
            match SetNamedSecurityInfoW(
                name.as_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                dacl,
                null(),
            ) {
                0 => Ok(()),
                failed => Err(io::Error::from_raw_os_error(failed as i32)),
            }
        })();
        LocalFree(descriptor);
        kept
    }
}

/// Keep `directory` to its owner: the sign-in store's directory mode, as the
/// launcher keeps its state home.
#[cfg(unix)]
fn owner_only(directory: &Path) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(
        directory,
        fs::Permissions::from_mode(OWNER_ONLY_DIRECTORY_MODE),
    )
}

/// How a file of the store is made, or opened over what is there: written,
/// and on a system that has modes made with the store's file mode.
fn owner_only_file() -> OpenOptions {
    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(OWNER_ONLY_FILE_MODE);
    }
    options
}

/// The systems the state home differs by, as
/// protocol/specs/src/sign-in-store/cases.json names them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum System {
    MacOs,
    Windows,
    /// Anything else: Linux, and every other Unix.
    Other,
}

impl System {
    /// The system this crate was built for.
    pub const fn of_this_build() -> System {
        if cfg!(target_os = "macos") {
            System::MacOs
        } else if cfg!(windows) {
            System::Windows
        } else {
            System::Other
        }
    }

    /// The system as the cases name it: `macos`, `windows`, or anything else.
    pub fn named(name: &str) -> System {
        match name {
            "macos" => System::MacOs,
            "windows" => System::Windows,
            _ => System::Other,
        }
    }
}

/// The launcher's state home, from what the system says of the person's
/// directories (protocol/specs/src/sign-in-store/cases.json): `home` is the home
/// directory (`HOME`, or `USERPROFILE` on Windows), `xdg_state_home` is
/// `XDG_STATE_HOME` and `local_app_data` is `LOCALAPPDATA`, each none when it
/// is not set. None when there is no home.
///
/// The path is composed with the system's own separator, not this build's: a
/// case gives one answer whichever machine computes it.
///
/// This crate reads no environment: a service links it, and what a service
/// reads of its environment is a contract. An application reads its own and
/// says what it found:
/// `state_dir(System::of_this_build(), home, xdg_state_home, local_app_data)`.
pub fn state_dir(
    system: System,
    home: Option<&str>,
    xdg_state_home: Option<&str>,
    local_app_data: Option<&str>,
) -> Option<PathBuf> {
    let home = home.filter(|home| !home.is_empty())?;
    let under = |separator: char, base: &str, names: &[&str]| {
        let mut dir = base.trim_end_matches(separator).to_owned();
        for name in names {
            dir.push(separator);
            dir.push_str(name);
        }
        PathBuf::from(dir)
    };
    Some(match system {
        System::MacOs => under('/', home, &["Library", "Application Support", "semiont"]),
        System::Windows => match local_app_data.filter(|local| !local.is_empty()) {
            Some(local) => under('\\', local, &["semiont"]),
            None => under('\\', home, &["AppData", "Local", "semiont"]),
        },
        System::Other => match xdg_state_home.filter(|state| !state.is_empty()) {
            Some(state) => under('/', state, &["semiont"]),
            None => under('/', home, &[".local", "state", "semiont"]),
        },
    })
}

/// A member of the document as a sign-in. One that is not a sign-in is none.
fn sign_in_of(member: &Value) -> Option<SignIn> {
    serde_json::from_value(member.clone()).ok()
}

/// A sign-in as the session a client holds: one with no refresh token is
/// none, because a session that cannot be renewed does not outlive its first
/// access token.
fn session_of(sign_in: &SignIn) -> Option<StoredSession> {
    Some(StoredSession {
        access: sign_in.token.clone(),
        refresh: sign_in
            .refresh_token
            .clone()
            .filter(|refresh| !refresh.is_empty())?,
        client_id: SCRIPT_CLIENT_ID.to_owned(),
        token_endpoint: sign_in.token_endpoint.clone(),
        revocation_endpoint: sign_in.revocation_endpoint.clone(),
        // The file keeps no person.
        person_key: None,
    })
}

/// Who signed in, when an access token names an address, and at which
/// issuer. A token the gateway admits names its issuer, so one that does not
/// is no sign-in, and is refused.
fn named_by(access: &str) -> Result<(Option<String>, String), &'static str> {
    let issuer = text_claim(access, "iss").ok_or("its access token names no issuer")?;
    Ok((text_claim(access, "email"), issuer))
}

/// A session as the sign-in the file keeps, of `email` at `issuer`.
fn entry_of(
    session: &StoredSession,
    email: Option<String>,
    issuer: String,
    now: SystemTime,
) -> Value {
    // A struct of strings always serializes to an object.
    serde_json::to_value(SignIn {
        token: session.access.clone(),
        refresh_token: Some(session.refresh.clone()),
        email,
        obtained_at: rfc3339::to_the_second(now),
        expires_at: token_expiry(&session.access).map(rfc3339::to_the_second),
        issuer,
        token_endpoint: session.token_endpoint.clone(),
        revocation_endpoint: session.revocation_endpoint.clone(),
    })
    .unwrap_or(Value::Null)
}

/// See the module's documentation.
pub struct SignInStore {
    file: Arc<File>,
}

/// The file, and the turn this process takes to change it.
struct File {
    path: PathBuf,
    /// One change at a time from this process: the file lock is between
    /// processes, and two handles of one process on one file do not exclude
    /// each other on every system.
    turn: Mutex<()>,
}

impl SignInStore {
    /// The store in the file at `path` (`FILE_NAME` in `state_dir`, for the
    /// launcher's).
    pub fn at(path: impl Into<PathBuf>) -> SignInStore {
        SignInStore {
            file: Arc::new(File {
                path: path.into(),
                turn: Mutex::new(()),
            }),
        }
    }

    /// The sign-in the file keeps under `key`, a stack's key (`local`,
    /// `codespace:<owner>/<name>`), as a sign-in kept. Every entry of one
    /// store takes its turn to change the file.
    pub fn entry(&self, key: &str) -> Arc<dyn SignInKept> {
        Arc::new(Entry {
            file: self.file.clone(),
            key: key.to_owned(),
        })
    }
}

/// What the file could not do, and why.
fn failure(doing: &str, path: &Path, error: &io::Error) -> Box<dyn Error + Send + Sync> {
    Box::new(io::Error::new(
        error.kind(),
        format!("{doing} {}: {error}", path.display()),
    ))
}

impl File {
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

    /// The sign-in the document holds under `key`, as a sign-in kept.
    fn held(&self, key: &str) -> Result<Option<StoredSession>, Box<dyn Error + Send + Sync>> {
        let document = self
            .read()
            .map_err(|error| failure("Could not read", &self.path, &error))?;
        Ok(document
            .get(key)
            .and_then(sign_in_of)
            .as_ref()
            .and_then(session_of))
    }

    /// Change the document as one step: read it, change it, and write it
    /// when `change` says it changed, with the lock held throughout. What
    /// `change` gives.
    fn change<T>(
        &self,
        change: impl FnOnce(&mut Map<String, Value>) -> (bool, T),
    ) -> Result<T, Box<dyn Error + Send + Sync>> {
        let _turn = locked(&self.turn);
        (|| -> io::Result<T> {
            // A path with no directory part is in the current one, as Go and Python read it.
            let directory = match self.path.parent() {
                Some(parent) if !parent.as_os_str().is_empty() => parent,
                _ => Path::new("."),
            };
            fs::create_dir_all(directory)?;
            let lock = owner_only_file().open(self.path.with_extension("lock"))?;
            lock.lock()?;
            // Under the lock: setting the list hands it down to the file, and
            // another writer renaming over the file at that moment would be
            // refused.
            owner_only(directory)?;
            let mut document = self.read()?;
            let (changed, given) = change(&mut document);
            if changed {
                self.write(&document)?;
            }
            Ok(given)
        })()
        .map_err(|error| failure("Could not change", &self.path, &error))
    }

    /// Written beside the file and renamed over it: no reader sees half a
    /// document, and no credential is left in a stray file.
    fn write(&self, document: &Map<String, Value>) -> io::Result<()> {
        let mut text = serde_json::to_string_pretty(document)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
        text.push('\n');
        let beside = self.path.with_extension("json.tmp");
        let written = owner_only_file()
            .open(&beside)
            .and_then(|mut file| file.write_all(text.as_bytes()))
            .and_then(|()| fs::rename(&beside, &self.path));
        if written.is_err() {
            let _ = fs::remove_file(&beside);
        }
        written
    }
}

/// One entry of the file, as a sign-in kept (`SignInStore::entry`).
struct Entry {
    file: Arc<File>,
    key: String,
}

impl Entry {
    /// Do `work` on the file off the runtime's threads: a change waits for
    /// the lock another process holds, and the runtime turns meanwhile.
    fn off_the_runtime<T: Send + 'static>(
        &self,
        work: impl FnOnce(&File, &str) -> Result<T, Box<dyn Error + Send + Sync>> + Send + 'static,
    ) -> BoxFuture<'static, Result<T, Box<dyn Error + Send + Sync>>> {
        let (file, key) = (self.file.clone(), self.key.clone());
        Box::pin(async move { tokio::task::spawn_blocking(move || work(&file, &key)).await? })
    }
}

impl SignInKept for Entry {
    fn held(&self) -> BoxFuture<'_, Result<Option<StoredSession>, Box<dyn Error + Send + Sync>>> {
        self.off_the_runtime(|file, key| file.held(key))
    }

    /// Kept as `semiont login` keeps one: the entry states who signed in,
    /// when the access token names an address, and at which issuer, whoever
    /// the entry before it was of. What another client was issued is not
    /// kept, and nor is a sign-in whose token names no issuer: each is the
    /// error, and the file is left as it was.
    fn keep(
        &self,
        sign_in: StoredSession,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        self.off_the_runtime(move |file, key| {
            if sign_in.client_id != SCRIPT_CLIENT_ID {
                return Err(format!(
                    "The sign-in store keeps what the client {SCRIPT_CLIENT_ID} was issued, and this was issued to {}",
                    sign_in.client_id
                )
                .into());
            }
            let (email, issuer) = named_by(&sign_in.access).map_err(|lacking| {
                SignInError::new(
                    SignInErrorCode::Exchange,
                    format!("The sign-in to {key} was not kept: {lacking}"),
                )
            })?;
            file.change(|document| {
                document.insert(
                    key.to_owned(),
                    entry_of(&sign_in, email, issuer, SystemTime::now()),
                );
                (true, ())
            })
        })
    }

    /// Written as the launcher writes a renewal: who signed in, and where,
    /// are kept as the sign-in learned them, whatever the renewed token names.
    fn renewed<'a>(
        &'a self,
        read: &'a StoredSession,
        access: &'a str,
        refresh: &'a str,
    ) -> BoxFuture<'a, Result<Option<String>, Box<dyn Error + Send + Sync>>> {
        let (read, access, refresh) = (read.clone(), access.to_owned(), refresh.to_owned());
        self.off_the_runtime(move |file, key| {
            file.change(|document| {
                let Some(sign_in) = document.get(key).and_then(sign_in_of) else {
                    return (false, None);
                };
                let Some(kept) = session_of(&sign_in) else {
                    return (false, None);
                };
                if kept.access != read.access || kept.refresh != read.refresh {
                    return (false, Some(kept.access));
                }
                let renewed = StoredSession {
                    access: access.clone(),
                    refresh,
                    ..kept
                };
                document.insert(
                    key.to_owned(),
                    entry_of(&renewed, sign_in.email, sign_in.issuer, SystemTime::now()),
                );
                (true, Some(access))
            })
        })
    }

    /// The file keeps no person: nothing is recorded, and the answer is
    /// false.
    fn record_person_key<'a>(
        &'a self,
        _access: &'a str,
        _person_key: &'a str,
    ) -> BoxFuture<'a, Result<bool, Box<dyn Error + Send + Sync>>> {
        Box::pin(async { Ok(false) })
    }

    /// The entry is removed, and no other; an entry that is not there
    /// writes nothing.
    fn forget(&self) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        self.off_the_runtime(|file, key| {
            file.change(|document| (document.remove(key).is_some(), ()))
        })
    }
}
