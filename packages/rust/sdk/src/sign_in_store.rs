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
//! **A session that is `set` is a sign-in**, and its entry states who signed
//! in and at which issuer as its own access token names them, whoever the
//! entry before it was of. **A session an `update` says in place of the
//! file's is that sign-in renewed**, and keeps both as the sign-in learned
//! them, whatever the renewed token names.
//!
//! **Every change is a read, a change and a write under a lock**
//! (`tokens.lock`, beside the file): another process renewing another stack
//! at the same moment loses nothing. What the file holds that is not a
//! sign-in as this release knows one is written back as it was. The file's
//! directory is kept to its owner first, as the launcher keeps its state
//! home: mode `0700`, and on Windows the launcher's access list, which what
//! is made in it inherits.
//!
//! A file that cannot be read or written is said to `on_failure`, and the
//! store then behaves as if the file held nothing, or the write was not
//! made. So is a session whose access token does not say who it is for or
//! who issued it: the file states both of every sign-in, and nothing is made
//! up for one. A write the storage beneath refuses is the write's error, and
//! the file is left as it was.

use crate::locked;
use crate::rfc3339;
use crate::session::{
    SCRIPT_CLIENT_ID, StoredSession, kb_of_session_key, text_claim, token_expiry,
};
use crate::storage::{SessionStorage, StorageChange, StorageSubscription};
use serde_json::{Map, Value};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

include!(concat!(env!("OUT_DIR"), "/sign_in.rs"));

/// The file's name in the launcher's state home.
pub const FILE_NAME: &str = "tokens.json";

/// Keep `directory`, and everything made in it from then on, to its owner,
/// with the access list the launcher gives its state home: the user this
/// process runs as, the system and the administrators, each with full
/// access, handed down to what is made in it, and nothing inherited from
/// above. A mode keeps nobody out on Windows; the access list is what does. A
/// directory that has the list already is left as it is: setting a list
/// hands it down to everything beneath, which in a state home is no small
/// walk.
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
        let list = format!(
            "D:PAI(A;OICI;FA;;;{})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)",
            taken(named)
        );

        let name = wide(directory.as_os_str());
        let (mut dacl, mut descriptor): (*mut ACL, PSECURITY_DESCRIPTOR) = (null_mut(), null_mut());
        let failed = GetNamedSecurityInfoW(
            name.as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            &mut dacl,
            null_mut(),
            &mut descriptor,
        );
        if failed != 0 {
            return Err(io::Error::from_raw_os_error(failed as i32));
        }
        let mut written = null_mut();
        let read = ConvertSecurityDescriptorToStringSecurityDescriptorW(
            descriptor,
            SDDL_REVISION_1,
            DACL_SECURITY_INFORMATION,
            &mut written,
            null_mut(),
        );
        LocalFree(descriptor);
        if read == 0 {
            return Err(io::Error::last_os_error());
        }
        if taken(written) == list {
            return Ok(());
        }

        let sddl = wide(OsStr::new(&list));
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
        let (mut present, mut defaulted) = (0, 0);
        let mut dacl: *mut ACL = null_mut();
        let kept = if GetSecurityDescriptorDacl(descriptor, &mut present, &mut dacl, &mut defaulted)
            == 0
        {
            Err(io::Error::last_os_error())
        } else {
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
        };
        LocalFree(descriptor);
        kept
    }
}

/// Keep `directory` to its owner: mode `0700`, as the launcher keeps its
/// state home.
#[cfg(unix)]
fn owner_only(directory: &Path) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(directory, fs::Permissions::from_mode(0o700))
}

/// The systems the state home differs by, as
/// specs/src/sign-in-store/cases.json names them.
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
/// directories (specs/src/sign-in-store/cases.json): `home` is the home
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
    /// when `change` says it changed, with the lock held throughout. What
    /// the storage beneath refused is the error.
    fn change(
        &self,
        change: impl FnOnce(
            &mut Map<String, Value>,
        ) -> (bool, Result<(), Box<dyn std::error::Error + Send + Sync>>),
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let _turn = locked(&self.turn);
        let changed = (|| -> io::Result<Result<(), Box<dyn std::error::Error + Send + Sync>>> {
            // A path with no directory part is in the current one, as Go and Python read it.
            let directory = match self.path.parent() {
                Some(parent) if !parent.as_os_str().is_empty() => parent,
                _ => Path::new("."),
            };
            fs::create_dir_all(directory)?;
            owner_only(directory)?;
            let lock = File::create(self.path.with_extension("lock"))?;
            lock.lock()?;
            let mut document = self.read()?;
            let (changed, beneath) = change(&mut document);
            if changed {
                self.write(&document)?;
            }
            Ok(beneath)
        })();
        match changed {
            Ok(beneath) => beneath,
            Err(error) => {
                self.failed("Could not change", &error);
                Ok(())
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
    /// neither. `renewed` is the sign-in a session of the script client
    /// renews, and none when the session is a sign-in of its own: one that
    /// is no sign-in is kept nowhere, and that is said. `document` is the
    /// file's, held under the lock. Whether the document changed, and what
    /// the storage beneath refused, which changes nothing.
    fn put(
        &self,
        document: &mut Map<String, Value>,
        key: &str,
        kb_id: &str,
        next: Option<&str>,
        renewed: Option<&SignIn>,
    ) -> (bool, Result<(), Box<dyn std::error::Error + Send + Sync>>) {
        match (next, next.and_then(StoredSession::read)) {
            (_, Some(session)) if session.client_id == SCRIPT_CLIENT_ID => {
                let signed_in = match renewed {
                    Some(sign_in) => Ok((sign_in.email.clone(), sign_in.issuer.clone())),
                    None => named_by(&session.access),
                };
                match signed_in {
                    Ok((email, issuer)) => {
                        if let Err(refused) = self.rest.delete(key) {
                            return (false, Err(refused));
                        }
                        document.insert(
                            kb_id.to_owned(),
                            entry_of(&session, email, issuer, SystemTime::now()),
                        );
                        (true, Ok(()))
                    }
                    Err(lacking) => {
                        (self.on_failure)(&format!(
                            "The sign-in to {kb_id} was not kept: {lacking}"
                        ));
                        (false, Ok(()))
                    }
                }
            }
            (Some(next), _) => (false, self.rest.set(key, next)),
            (None, _) => match self.rest.delete(key) {
                Ok(()) => (document.remove(kb_id).is_some(), Ok(())),
                Err(refused) => (false, Err(refused)),
            },
        }
    }
}

impl SessionStorage for SignInStore {
    fn get(&self, key: &str) -> Option<String> {
        self.rest.get(key).or_else(|| {
            let sign_in = sign_in_of(&self.entry(kb_of_session_key(key)?)?)?;
            Some(session_of(&sign_in)?.written())
        })
    }

    fn set(&self, key: &str, value: &str) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        match kb_of_session_key(key) {
            Some(kb_id) => {
                self.change(|document| self.put(document, key, kb_id, Some(value), None))
            }
            None => self.rest.set(key, value),
        }
    }

    fn delete(&self, key: &str) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        match kb_of_session_key(key) {
            Some(kb_id) => self.change(|document| self.put(document, key, kb_id, None, None)),
            None => self.rest.delete(key),
        }
    }

    fn update(
        &self,
        key: &str,
        change: &mut dyn FnMut(Option<&str>) -> Option<String>,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let Some(kb_id) = kb_of_session_key(key) else {
            return self.rest.update(key, change);
        };
        self.change(|document| {
            let beneath = self.rest.get(key);
            let sign_in = match beneath {
                Some(_) => None,
                None => document.get(kb_id).and_then(sign_in_of),
            };
            let held = sign_in
                .as_ref()
                .and_then(session_of)
                .map(|session| session.written());
            // Only a sign-in `change` is given is renewed by what it says.
            let renewed = sign_in.filter(|_| held.is_some());
            let current = beneath.or(held);
            let next = change(current.as_deref());
            if next == current {
                return (false, Ok(()));
            }
            self.put(document, key, kb_id, next.as_deref(), renewed.as_ref())
        })
    }

    /// What another context writes to the storage beneath. The file is not
    /// watched: what another process renewed is read the next time this
    /// one renews, and used as it is (specs/src/sign-in-store/README.md,
    /// Renewing it).
    fn subscribe(&self, on_change: StorageChange) -> Option<StorageSubscription> {
        self.rest.subscribe(on_change)
    }
}
