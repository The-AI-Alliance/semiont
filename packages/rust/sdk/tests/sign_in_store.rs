//! The sign-ins `semiont login` keeps (protocol/specs/src/sign-in-store):
//! where the file is, and each of its entries as a sign-in kept
//! (`SignInStore::entry`): a launcher's entry held as a sign-in, a sign-in
//! kept and renewed as the launcher keeps one, and two writers that lose
//! nothing of each other's. Where the file is, is the `cases` of
//! protocol/specs/src/sign-in-store/cases.json; its `renewals` are run where the
//! renewal is, in semiont-http-transport's tests/sign_in.rs.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use semiont::errors::{SignInError, SignInErrorCode};
use semiont::session::{SignInKept, StoredSession, person_key};
use semiont::sign_in_store::{SignInStore, System, state_dir};
use serde_json::{Value, json};
use std::error::Error;
use std::path::PathBuf;
use std::sync::Arc;

// ── Where it is ─────────────────────────────────────────────────────────

#[test]
fn the_state_home_is_where_the_shared_cases_say() {
    let table: Value = serde_json::from_str(include_str!("../specs/sign-in-store/cases.json"))
        .expect("the table is JSON");
    let cases = table["cases"].as_array().expect("the table has cases");
    assert!(!cases.is_empty());
    for case in cases {
        let found = state_dir(
            System::named(case["os"].as_str().expect("a case names its system")),
            case["home"].as_str(),
            case["xdgStateHome"].as_str(),
            case["localAppData"].as_str(),
        );
        assert_eq!(
            found.map(|dir| dir.to_string_lossy().into_owned()),
            case["dir"].as_str().map(str::to_owned),
            "{}",
            case["why"]
        );
    }
}

// ── The file ────────────────────────────────────────────────────────────

/// A state home of its own, removed when the test is done with it.
struct Home {
    dir: PathBuf,
}

impl Drop for Home {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

impl Home {
    fn new() -> Home {
        Home {
            dir: std::env::temp_dir().join(format!("semiont-sign-ins-{}", uuid::Uuid::new_v4())),
        }
    }

    fn path(&self) -> PathBuf {
        self.dir.join("tokens.json")
    }

    /// A state home in which the launcher has written this document.
    fn holding(document: Value) -> Home {
        let home = Home::new();
        std::fs::create_dir_all(&home.dir).expect("a directory");
        std::fs::write(home.path(), document.to_string()).expect("a file");
        home
    }

    fn store(&self) -> SignInStore {
        SignInStore::at(self.path())
    }

    /// The sign-in kept under `key`, through a store of its own.
    fn entry(&self, key: &str) -> Arc<dyn SignInKept> {
        self.store().entry(key)
    }

    fn document(&self) -> Value {
        serde_json::from_str(&self.text()).expect("the file is JSON")
    }

    fn text(&self) -> String {
        std::fs::read_to_string(self.path()).expect("the file is there")
    }

    fn written_at(&self) -> std::time::SystemTime {
        std::fs::metadata(self.path())
            .expect("the file is there")
            .modified()
            .expect("the file says when it was written")
    }
}

/// What `kept` holds: a read that fails is no answer.
async fn held(kept: &dyn SignInKept) -> Option<StoredSession> {
    kept.held().await.expect("the sign-in is read")
}

fn jwt(claims: Value) -> String {
    format!(
        "{}.{}.sig",
        URL_SAFE_NO_PAD.encode(r#"{"alg":"none"}"#),
        URL_SAFE_NO_PAD.encode(claims.to_string())
    )
}

const ISSUER: &str = "https://issuer.test/realms/semiont";

/// An access token as an issuer the gateway trusts issues one: it names who
/// it is for and who issued it. `tag` tells one from another.
fn issued(tag: &str) -> String {
    jwt(json!({ "iss": ISSUER, "email": "bob@example.org", "tag": tag }))
}

/// An entry as `semiont login` writes one.
fn launchers(token: &str, refresh: &str) -> Value {
    json!({
        "token": token,
        "refreshToken": refresh,
        "email": "alice@example.org",
        "obtainedAt": "2026-10-01T12:00:00Z",
        "expiresAt": "2026-10-01T12:05:00Z",
        "issuer": ISSUER,
        "tokenEndpoint": "https://issuer.test/realms/semiont/token",
        "revocationEndpoint": "https://issuer.test/realms/semiont/revoke",
    })
}

fn script(access: &str, refresh: &str) -> StoredSession {
    StoredSession {
        access: access.to_owned(),
        refresh: refresh.to_owned(),
        client_id: "semiont-cli".to_owned(),
        token_endpoint: "https://issuer.test/realms/semiont/token".to_owned(),
        revocation_endpoint: Some("https://issuer.test/realms/semiont/revoke".to_owned()),
        person_key: None,
    }
}

/// The sign-in error a failure is.
fn sign_in_error(failure: Box<dyn Error + Send + Sync>) -> SignInError {
    match failure.downcast::<SignInError>() {
        Ok(refused) => *refused,
        Err(other) => panic!("{other} is not a sign-in error"),
    }
}

#[tokio::test]
async fn a_stacks_sign_in_is_held_by_the_entry_under_its_key() {
    let home = Home::holding(json!({
        "local": launchers("a1", "r1"),
        "codespace:owner/name": launchers("a2", "r2"),
    }));

    assert_eq!(
        held(home.entry("local").as_ref()).await,
        Some(script("a1", "r1"))
    );
    assert_eq!(
        held(home.entry("codespace:owner/name").as_ref()).await,
        Some(script("a2", "r2"))
    );
    assert_eq!(held(home.entry("another").as_ref()).await, None);
}

#[tokio::test]
async fn a_sign_in_that_cannot_be_renewed_is_none_to_hold() {
    let mut without_refresh = launchers("a1", "r1");
    without_refresh
        .as_object_mut()
        .expect("an entry")
        .remove("refreshToken");
    // Nor is an entry that does not say at which issuer it was made.
    let mut from_nowhere = launchers("a1", "r1");
    from_nowhere
        .as_object_mut()
        .expect("an entry")
        .remove("issuer");
    let home = Home::holding(json!({
        "local": without_refresh, "other": "not an entry", "from-nowhere": from_nowhere,
    }));

    for key in ["local", "other", "from-nowhere"] {
        assert_eq!(held(home.entry(key).as_ref()).await, None, "{key}");
    }
}

#[tokio::test]
async fn an_entry_that_names_no_address_is_a_sign_in() {
    let mut by_an_account_with_none = launchers("a1", "r1");
    by_an_account_with_none
        .as_object_mut()
        .expect("an entry")
        .remove("email");
    let home = Home::holding(json!({ "local": by_an_account_with_none }));

    assert_eq!(
        held(home.entry("local").as_ref()).await,
        Some(script("a1", "r1"))
    );
}

#[tokio::test]
async fn with_no_file_there_is_no_sign_in_and_reading_makes_nothing() {
    let home = Home::new();
    assert_eq!(held(home.entry("local").as_ref()).await, None);
    assert!(!home.path().exists());
}

#[tokio::test]
async fn a_renewal_is_written_as_the_launcher_keeps_it_and_keeps_what_the_sign_in_learned() {
    let home = Home::holding(json!({
        "local": launchers("a1", "r1"),
        "codespace:owner/name": launchers("a2", "r2"),
        "a-later-release": { "of": "something else" },
    }));
    let kept = home.entry("local");
    // The renewed token names another address and another issuer.
    let renewed = jwt(json!({
        "iss": "https://elsewhere.test/realms/semiont",
        "email": "alice@elsewhere.example",
        "exp": 4_102_444_799u64,
    }));

    let given = kept
        .renewed(&script("a1", "r1"), &renewed, "r1-rotated")
        .await
        .expect("kept");

    assert_eq!(given, Some(renewed.clone()));
    let document = home.document();
    let entry = &document["local"];
    assert_eq!(entry["token"], renewed);
    assert_eq!(entry["refreshToken"], "r1-rotated");
    // Who signed in, and where, are the sign-in's, and a renewal keeps them.
    assert_eq!(entry["email"], "alice@example.org");
    assert_eq!(entry["issuer"], "https://issuer.test/realms/semiont");
    assert_eq!(entry["expiresAt"], "2099-12-31T23:59:59Z");
    assert_ne!(entry["obtainedAt"], "2026-10-01T12:00:00Z");
    assert!(
        entry["obtainedAt"]
            .as_str()
            .is_some_and(|at| at.ends_with('Z') && at.len() == 20),
        "{entry}"
    );
    // Every other member is as it was, the one this release cannot read too.
    assert_eq!(document["codespace:owner/name"], launchers("a2", "r2"));
    assert_eq!(
        document["a-later-release"],
        json!({ "of": "something else" })
    );
    assert_eq!(
        held(kept.as_ref()).await,
        Some(script(&renewed, "r1-rotated"))
    );
}

/// A renewal of a sign-in that is no longer the one kept: another program
/// renewed, or signed in again, while this one's grant was in flight. What
/// it kept stands, its access token is the one given, and nothing is
/// written. A renewal of an entry that holds no sign-in keeps nothing.
#[tokio::test]
async fn a_renewal_of_what_is_no_longer_kept_gives_what_is_kept_and_writes_nothing() {
    let home = Home::holding(json!({ "local": launchers("a1", "r1") }));
    let before = home.text();
    let written = home.written_at();

    let given = home
        .entry("local")
        .renewed(&script("a0", "r0"), "a2", "r2")
        .await
        .expect("kept");
    assert_eq!(given.as_deref(), Some("a1"));

    let nothing = home
        .entry("never-signed-in")
        .renewed(&script("a0", "r0"), "a2", "r2")
        .await
        .expect("kept");
    assert_eq!(nothing, None);

    assert_eq!(home.text(), before);
    assert_eq!(home.written_at(), written);
}

/// The user this process runs as, and the access list of the file at
/// `path` as Windows writes it out (SDDL), each as PowerShell reads it. The
/// user is named as an access list written out names it: by its SID, or by
/// an abbreviation (the built-in administrator is `LA`). Windows PowerShell
/// is given no `PSModulePath`: the one PowerShell 7 sets, which a CI step's
/// shell hands down, leads it to modules it cannot load.
#[cfg(windows)]
fn access_list_of(path: &std::path::Path) -> (String, String) {
    let script = format!(
        "[Security.AccessControl.RawSecurityDescriptor]::new('O:' + [Security.Principal.WindowsIdentity]::GetCurrent().User.Value).GetSddlForm('Owner').Substring(2); (Get-Acl -LiteralPath '{}').GetSecurityDescriptorSddlForm('Access')",
        path.display().to_string().replace('\'', "''")
    );
    let out = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .env_remove("PSModulePath")
        .output()
        .expect("PowerShell runs");
    assert!(
        out.status.success(),
        "PowerShell exited {}: {}",
        out.status,
        String::from_utf8_lossy(&out.stderr)
    );
    let said: Vec<String> = String::from_utf8_lossy(&out.stdout)
        .split_whitespace()
        .map(str::to_owned)
        .collect();
    match said.as_slice() {
        [user, list] => (user.clone(), list.clone()),
        _ => panic!("PowerShell said {said:?}"),
    }
}

/// An access list's flags (`D:PAI`) and its entries, sorted. PowerShell
/// reads a list through .NET, which writes the entries a list sets itself in
/// an order of its own (by SID), and the order of entries that each allow
/// does not change what they allow.
#[cfg(windows)]
fn entries_of(list: &str) -> (&str, Vec<String>) {
    let (flags, entries) = list.split_at(list.find('(').expect("an access list with entries"));
    let mut entries: Vec<String> = entries.split_inclusive(')').map(str::to_owned).collect();
    entries.sort();
    (flags, entries)
}

#[tokio::test]
async fn the_file_is_written_whole_for_its_owner_alone() {
    let home = Home::new();
    home.entry("local")
        .keep(script(&issued("a1"), "r1"))
        .await
        .expect("kept");

    let text = home.text();
    assert!(
        text.starts_with("{\n  \"local\": {\n") && text.ends_with("}\n"),
        "{text}"
    );
    // In a directory kept to its owner, as the launcher keeps its state home.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = |path: &std::path::Path| {
            std::fs::metadata(path)
                .expect("metadata")
                .permissions()
                .mode()
                & 0o777
        };
        assert_eq!(mode(&home.dir), 0o700);
        assert_eq!(mode(&home.path()), 0o600);
    }
    // The launcher's access list: the user, the system and the
    // administrators, handed down to what is made in it, and nothing
    // inherited from above.
    #[cfg(windows)]
    {
        let (user, list) = access_list_of(&home.dir);
        let owner_only = |inherit: &str| {
            let mut entries: Vec<String> = [user.as_str(), "SY", "BA"]
                .iter()
                .map(|who| format!("(A;{inherit};FA;;;{who})"))
                .collect();
            entries.sort();
            entries
        };
        let (flags, entries) = entries_of(&list);
        assert!(
            ["D:PAI", "D:P"].contains(&flags) && entries == owner_only("OICI"),
            "the state home's access list is {list}, not its owner's ({user}) alone"
        );
        for made in [home.path(), home.dir.join("tokens.lock")] {
            let (_, list) = access_list_of(&made);
            let (flags, entries) = entries_of(&list);
            assert!(
                ["D:AI", "D:"].contains(&flags) && entries == owner_only("ID"),
                "{}'s access list is {list}, not the one its directory hands down to its owner ({user})",
                made.display()
            );
        }
    }
    // Nothing is left beside it but the lock.
    let mut beside: Vec<String> = std::fs::read_dir(&home.dir)
        .expect("the directory is there")
        .map(|entry| {
            entry
                .expect("an entry")
                .file_name()
                .to_string_lossy()
                .into_owned()
        })
        .collect();
    beside.sort();
    assert_eq!(beside, ["tokens.json", "tokens.lock"]);
}

#[tokio::test]
async fn a_new_sign_in_states_who_signed_in_and_at_which_issuer() {
    let home = Home::new();
    let named = jwt(json!({ "iss": ISSUER, "email": "bob@example.org", "exp": 4_102_444_799u64 }));

    home.entry("local")
        .keep(script(&named, "r1"))
        .await
        .expect("kept");
    home.entry("codespace:owner/name")
        .keep(script(&issued("a2"), "r2"))
        .await
        .expect("kept");

    assert_eq!(
        home.document()["local"],
        json!({
            "token": named,
            "refreshToken": "r1",
            "email": "bob@example.org",
            "obtainedAt": home.document()["local"]["obtainedAt"],
            "expiresAt": "2099-12-31T23:59:59Z",
            "issuer": ISSUER,
            "tokenEndpoint": "https://issuer.test/realms/semiont/token",
            "revocationEndpoint": "https://issuer.test/realms/semiont/revoke",
        })
    );
    // A token that names no lifetime leaves the expiry unsaid.
    let unbounded = home.document()["codespace:owner/name"].clone();
    assert!(
        !unbounded
            .as_object()
            .expect("an entry")
            .contains_key("expiresAt")
    );
}

#[tokio::test]
async fn a_sign_in_over_another_persons_states_who_signed_in_now_and_at_which_issuer() {
    let home = Home::new();
    let kept = home.entry("local");
    let alices = jwt(json!({ "iss": ISSUER, "email": "alice@example.org" }));
    kept.keep(script(&alices, "r-alice")).await.expect("kept");
    assert_eq!(home.document()["local"]["email"], "alice@example.org");

    let elsewhere = "https://elsewhere.test/realms/semiont";
    let bobs = jwt(json!({ "iss": elsewhere, "email": "bob@example.org" }));
    kept.keep(script(&bobs, "r-bob")).await.expect("kept");

    let document = home.document();
    let entry = &document["local"];
    assert_eq!(entry["token"], bobs);
    assert_eq!(entry["refreshToken"], "r-bob");
    assert_eq!(entry["email"], "bob@example.org");
    assert_eq!(entry["issuer"], elsewhere);
}

#[tokio::test]
async fn a_sign_in_whose_token_names_no_address_is_kept_without_one() {
    let home = Home::new();
    let kept = home.entry("local");
    let unaddressed = jwt(json!({ "iss": ISSUER, "sub": "an-account" }));

    kept.keep(script(&unaddressed, "r1")).await.expect("kept");

    let document = home.document();
    let entry = &document["local"];
    assert_eq!(entry["issuer"], ISSUER);
    assert!(!entry.as_object().expect("an entry").contains_key("email"));
    assert_eq!(held(kept.as_ref()).await, Some(script(&unaddressed, "r1")));

    // A renewal whose token names an address keeps none: the sign-in learned none.
    let renewed = jwt(json!({ "iss": ISSUER, "email": "bob@example.org" }));
    let given = kept
        .renewed(&script(&unaddressed, "r1"), &renewed, "r2")
        .await
        .expect("kept");
    assert_eq!(given, Some(renewed.clone()));
    let document = home.document();
    let entry = &document["local"];
    assert_eq!(entry["token"], renewed);
    assert!(!entry.as_object().expect("an entry").contains_key("email"));
}

/// A gateway admits no token from an issuer it does not trust: a sign-in
/// whose token names none is no sign-in, is kept nowhere, and keeping it is
/// the error.
#[tokio::test]
async fn a_sign_in_whose_token_names_no_issuer_is_not_kept_and_that_is_the_error() {
    let home = Home::holding(json!({ "codespace:owner/name": launchers("a2", "r2") }));
    let kept = home.entry("local");
    let from_nowhere = jwt(json!({ "email": "bob@example.org" }));

    for access in [from_nowhere.as_str(), "opaque"] {
        let refused = sign_in_error(
            kept.keep(script(access, "r1"))
                .await
                .expect_err("no sign-in is kept"),
        );
        assert_eq!(refused.code, SignInErrorCode::Exchange);
        assert_eq!(
            refused.message,
            "The sign-in to local was not kept: its access token names no issuer"
        );
    }

    // Nothing is made up for it.
    assert_eq!(
        home.document(),
        json!({ "codespace:owner/name": launchers("a2", "r2") })
    );
    assert_eq!(held(kept.as_ref()).await, None);
}

/// What another client was issued would be renewed here as the wrong
/// client: the file keeps only the script client's sign-ins, and keeping
/// another's is the error. The launcher's entry is left as it was.
#[tokio::test]
async fn what_another_client_was_issued_is_not_kept() {
    let home = Home::holding(json!({ "local": launchers("a1", "r1") }));
    let kept = home.entry("local");
    let browsers = StoredSession {
        client_id: "semiont-browser".to_owned(),
        ..script(&issued("b1"), "rb")
    };

    let refused = kept.keep(browsers).await.expect_err("it is not kept");

    assert!(refused.to_string().contains("semiont-browser"), "{refused}");
    assert_eq!(home.document()["local"], launchers("a1", "r1"));
    assert_eq!(held(kept.as_ref()).await, Some(script("a1", "r1")));
}

#[tokio::test]
async fn forgetting_removes_the_entry_and_no_other() {
    let home = Home::holding(json!({
        "local": launchers("a1", "r1"),
        "codespace:owner/name": launchers("a2", "r2"),
    }));

    home.entry("local").forget().await.expect("forgotten");
    home.entry("never-signed-in")
        .forget()
        .await
        .expect("forgotten");

    assert_eq!(
        home.document(),
        json!({ "codespace:owner/name": launchers("a2", "r2") })
    );
    assert_eq!(held(home.entry("local").as_ref()).await, None);
}

#[tokio::test]
async fn forgetting_what_is_not_kept_writes_nothing() {
    let home = Home::new();
    let kept = home.entry("local");
    kept.keep(script(&issued("a1"), "r1")).await.expect("kept");
    kept.forget().await.expect("forgotten");
    assert_eq!(home.document(), json!({}));
    let written = home.written_at();

    kept.forget().await.expect("forgotten");

    assert_eq!(home.written_at(), written);
}

#[tokio::test]
async fn what_the_file_holds_that_is_not_this_sign_in_is_written_back_as_it_was() {
    let home = Home::new();
    let store = home.store();
    store
        .entry("codespace:owner/name")
        .keep(script(&issued("a7"), "r7"))
        .await
        .expect("kept");
    let others = json!({
        "codespace:owner/name": home.document()["codespace:owner/name"],
        // What a later release wrote, and this one does not understand.
        "later": { "shape": ["unknown", 1, null], "nested": { "deep": true } },
        "not-even-an-object": 3,
    });
    std::fs::write(home.path(), others.to_string()).expect("a file");

    let first = script(&issued("a1"), "r1");
    store
        .entry("local")
        .keep(first.clone())
        .await
        .expect("kept");
    let renewed = issued("a2");
    let given = store
        .entry("local")
        .renewed(&first, &renewed, "r2")
        .await
        .expect("kept");
    assert_eq!(given, Some(renewed));
    let mut document = home.document();
    document
        .as_object_mut()
        .expect("a document")
        .remove("local");
    assert_eq!(document, others);
    // What is not a sign-in is none to hold, and is not renewed into one.
    assert_eq!(held(store.entry("later").as_ref()).await, None);
    let nothing = store
        .entry("later")
        .renewed(&script(&issued("a3"), "r3"), &issued("a3"), "r3")
        .await
        .expect("kept");
    assert_eq!(nothing, None);

    store.entry("local").forget().await.expect("forgotten");
    assert_eq!(home.document(), others);
}

/// The file keeps no person: a sign-in kept there records nobody the
/// gateway names, and a session over it keeps nothing for them.
#[tokio::test]
async fn an_entry_records_no_person() {
    let home = Home::new();
    let kept = home.entry("local");
    let signed_in = script(&issued("a1"), "r1");
    kept.keep(signed_in.clone()).await.expect("kept");

    let recorded = kept
        .record_person_key(
            &signed_in.access,
            &person_key("did:web:example.org:users:a"),
        )
        .await
        .expect("asked");

    assert!(!recorded);
    assert_eq!(held(kept.as_ref()).await, Some(signed_in));
    assert!(
        !home.document()["local"]
            .as_object()
            .expect("an entry")
            .contains_key("personKey")
    );
}

#[tokio::test]
async fn a_file_that_cannot_be_read_is_the_error_and_is_never_written_over() {
    let home = Home::new();
    std::fs::create_dir_all(&home.dir).expect("a directory");
    std::fs::write(home.path(), "{ not json").expect("a file");
    let kept = home.entry("local");

    let read = kept.held().await.expect_err("the file cannot be read");
    let kept_over = kept
        .keep(script(&issued("a1"), "r1"))
        .await
        .expect_err("the file cannot be changed");
    let forgotten = kept.forget().await.expect_err("the file cannot be changed");

    assert!(read.to_string().starts_with("Could not read"), "{read}");
    for failed in [kept_over, forgotten] {
        assert!(
            failed.to_string().starts_with("Could not change"),
            "{failed}"
        );
    }
    assert_eq!(home.text(), "{ not json");
}

#[test]
fn two_writers_of_one_file_lose_nothing_of_each_others() {
    let home = Home::new();
    let rounds = 150;
    let writers: Vec<std::thread::JoinHandle<()>> = ["local", "codespace:owner/name"]
        .into_iter()
        .map(|key| {
            // Each its own store, as two processes have.
            let kept = home.entry(key);
            std::thread::spawn(move || {
                let runtime = tokio::runtime::Builder::new_current_thread()
                    .build()
                    .expect("a runtime");
                runtime.block_on(async {
                    for n in 0..rounds {
                        kept.keep(script(&issued(&format!("{key}-{n}")), "r"))
                            .await
                            .expect("kept");
                    }
                });
            })
        })
        .collect();
    for writer in writers {
        writer.join().expect("the writer ran");
    }

    let document = home.document();
    let last = rounds - 1;
    assert_eq!(document["local"]["token"], issued(&format!("local-{last}")));
    assert_eq!(
        document["codespace:owner/name"]["token"],
        issued(&format!("codespace:owner/name-{last}"))
    );
}
