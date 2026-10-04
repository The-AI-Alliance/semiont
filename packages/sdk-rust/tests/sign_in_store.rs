//! The sign-ins `semiont login` keeps, as a storage
//! (specs/src/sign-in-store): where the file is, a launcher's entry as a
//! session and a session as an entry, and two writers that lose nothing of
//! each other's.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use semiont::session::{StoredSession, session_key, store_session, stored_session};
use semiont::sign_in_store::{SignInStore, System, state_dir};
use semiont::storage::{InMemorySessionStorage, SessionStorage};
use serde_json::{Value, json};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

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
    rest: Arc<InMemorySessionStorage>,
    failures: Arc<Mutex<Vec<String>>>,
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
            rest: Arc::new(InMemorySessionStorage::new()),
            failures: Arc::default(),
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
        let failures = self.failures.clone();
        SignInStore::at(
            self.path(),
            self.rest.clone(),
            Arc::new(move |why| failures.lock().expect("failures").push(why.to_owned())),
        )
    }

    fn document(&self) -> Value {
        serde_json::from_str(&std::fs::read_to_string(self.path()).expect("the file is there"))
            .expect("the file is JSON")
    }

    fn failures(&self) -> Vec<String> {
        self.failures.lock().expect("failures").clone()
    }
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
    }
}

#[test]
fn a_stacks_sign_in_is_the_session_of_the_knowledge_base_with_its_key() {
    let home = Home::holding(json!({
        "local": launchers("a1", "r1"),
        "codespace:owner/name": launchers("a2", "r2"),
    }));
    let store = home.store();

    assert_eq!(stored_session(&store, "local"), Some(script("a1", "r1")));
    assert_eq!(
        stored_session(&store, "codespace:owner/name"),
        Some(script("a2", "r2"))
    );
    assert_eq!(stored_session(&store, "another"), None);
    assert!(home.failures().is_empty());
}

#[test]
fn a_sign_in_that_cannot_be_renewed_is_no_session() {
    let mut without_refresh = launchers("a1", "r1");
    without_refresh
        .as_object_mut()
        .expect("an entry")
        .remove("refreshToken");
    // Nor is an entry that does not say who signed in, or at which issuer.
    let mut by_nobody = launchers("a1", "r1");
    by_nobody.as_object_mut().expect("an entry").remove("email");
    let mut from_nowhere = launchers("a1", "r1");
    from_nowhere
        .as_object_mut()
        .expect("an entry")
        .remove("issuer");
    let home = Home::holding(json!({
        "local": without_refresh, "other": "not an entry",
        "by-nobody": by_nobody, "from-nowhere": from_nowhere,
    }));
    let store = home.store();

    for key in ["local", "other", "by-nobody", "from-nowhere"] {
        assert_eq!(stored_session(&store, key), None, "{key}");
    }
}

#[test]
fn with_no_file_there_is_no_sign_in_and_nobody_is_told_of_a_failure() {
    let home = Home::new();
    assert_eq!(stored_session(&home.store(), "local"), None);
    assert!(home.failures().is_empty());
    assert!(!home.path().exists());
}

#[test]
fn a_renewal_is_written_as_the_launcher_keeps_it_and_keeps_what_the_sign_in_learned() {
    let home = Home::holding(json!({
        "local": launchers("a1", "r1"),
        "codespace:owner/name": launchers("a2", "r2"),
        "a-later-release": { "of": "something else" },
    }));
    let store = home.store();
    let renewed = jwt(json!({ "exp": 4_102_444_799u64 }));

    store_session(&store, "local", &script(&renewed, "r1-rotated"));

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
        stored_session(&store, "local"),
        Some(script(&renewed, "r1-rotated"))
    );
    assert!(home.rest.get(&session_key("local")).is_none());
    assert!(home.failures().is_empty());
}

#[cfg(unix)]
#[test]
fn the_file_is_written_whole_for_its_owner_alone() {
    use std::os::unix::fs::PermissionsExt;
    let home = Home::new();
    store_session(&home.store(), "local", &script(&issued("a1"), "r1"));

    let text = std::fs::read_to_string(home.path()).expect("the file is there");
    assert!(
        text.starts_with("{\n  \"local\": {\n") && text.ends_with("}\n"),
        "{text}"
    );
    let mode = std::fs::metadata(home.path())
        .expect("metadata")
        .permissions()
        .mode();
    assert_eq!(mode & 0o777, 0o600);
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

#[test]
fn a_new_sign_in_states_who_signed_in_and_at_which_issuer() {
    let home = Home::new();
    let store = home.store();
    let named = jwt(json!({ "iss": ISSUER, "email": "bob@example.org", "exp": 4_102_444_799u64 }));

    store_session(&store, "local", &script(&named, "r1"));
    store_session(&store, "codespace:owner/name", &script(&issued("a2"), "r2"));

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
    assert!(home.failures().is_empty(), "{:?}", home.failures());
}

#[test]
fn a_session_whose_token_does_not_say_who_or_which_issuer_is_not_kept_and_that_is_said() {
    let home = Home::holding(json!({ "codespace:owner/name": launchers("a2", "r2") }));
    let store = home.store();
    let by_nobody = jwt(json!({ "iss": ISSUER }));
    let from_nowhere = jwt(json!({ "email": "bob@example.org" }));

    store_session(&store, "local", &script(&by_nobody, "r1"));
    store_session(&store, "local", &script(&from_nowhere, "r1"));
    store_session(&store, "local", &script("opaque", "r1"));

    // Nothing is made up for it, and it is kept nowhere.
    assert_eq!(
        home.document(),
        json!({ "codespace:owner/name": launchers("a2", "r2") })
    );
    assert_eq!(stored_session(&store, "local"), None);
    assert_eq!(home.rest.get(&session_key("local")), None);
    assert_eq!(
        home.failures(),
        [
            "The sign-in to local was not kept: its access token names no email",
            "The sign-in to local was not kept: its access token names no issuer",
            "The sign-in to local was not kept: its access token names no email",
        ]
    );
}

#[test]
fn a_session_of_another_client_is_kept_beneath_and_the_launchers_entry_is_left() {
    let home = Home::holding(json!({ "local": launchers("a1", "r1") }));
    let store = home.store();
    let browsers = StoredSession {
        client_id: "semiont-browser".to_owned(),
        ..script("b1", "rb")
    };

    store_session(&store, "local", &browsers);

    // It is this application's session of that knowledge base now.
    assert_eq!(stored_session(&store, "local"), Some(browsers.clone()));
    assert_eq!(stored_session(home.rest.as_ref(), "local"), Some(browsers));
    assert_eq!(home.document()["local"], launchers("a1", "r1"));

    // A session of the script client replaces it, in the file.
    store_session(&store, "local", &script("a2", "r2"));
    assert_eq!(stored_session(&store, "local"), Some(script("a2", "r2")));
    assert_eq!(home.rest.get(&session_key("local")), None);
    assert_eq!(home.document()["local"]["token"], "a2");
}

#[test]
fn signing_out_removes_the_entry_and_no_other() {
    let home = Home::holding(json!({
        "local": launchers("a1", "r1"),
        "codespace:owner/name": launchers("a2", "r2"),
    }));
    let store = home.store();

    store.delete(&session_key("local"));
    store.delete(&session_key("never-signed-in"));

    assert_eq!(
        home.document(),
        json!({ "codespace:owner/name": launchers("a2", "r2") })
    );
    assert_eq!(stored_session(&store, "local"), None);
}

#[test]
fn a_change_is_made_against_what_the_file_holds_and_one_that_changes_nothing_writes_nothing() {
    let home = Home::holding(json!({ "local": launchers("a1", "r1") }));
    let store = home.store();
    let before = std::fs::read_to_string(home.path()).expect("the file is there");

    let mut seen = None;
    store.update(&session_key("local"), &mut |current| {
        seen = current.map(str::to_owned);
        current.map(str::to_owned)
    });
    assert_eq!(seen, Some(script("a1", "r1").written()));
    assert_eq!(
        std::fs::read_to_string(home.path()).expect("the file is there"),
        before
    );

    store.update(&session_key("local"), &mut |current| {
        StoredSession::read(current?).map(|session| {
            StoredSession {
                access: "a2".to_owned(),
                ..session
            }
            .written()
        })
    });
    assert_eq!(home.document()["local"]["token"], "a2");
    assert_eq!(home.document()["local"]["refreshToken"], "r1");

    store.update(&session_key("local"), &mut |_| None);
    assert_eq!(home.document(), json!({}));
}

#[test]
fn everything_that_is_not_a_sign_in_is_kept_beneath() {
    let home = Home::new();
    let store = home.store();

    store.set("semiont.knowledgeBases", "[]");
    store.update("semiont.openResourcesByKb", &mut |_| Some("{}".to_owned()));
    assert_eq!(store.get("semiont.knowledgeBases").as_deref(), Some("[]"));
    assert_eq!(
        home.rest.get("semiont.openResourcesByKb").as_deref(),
        Some("{}")
    );
    store.delete("semiont.knowledgeBases");
    assert_eq!(store.get("semiont.knowledgeBases"), None);
    // The file was never needed.
    assert!(!home.path().exists());
}

#[test]
fn a_file_that_cannot_be_read_is_said_and_is_never_written_over() {
    let home = Home::new();
    std::fs::create_dir_all(&home.dir).expect("a directory");
    std::fs::write(home.path(), "{ not json").expect("a file");
    let store = home.store();

    assert_eq!(stored_session(&store, "local"), None);
    store_session(&store, "local", &script("a1", "r1"));
    store.delete(&session_key("local"));

    assert_eq!(home.failures().len(), 3);
    assert!(
        home.failures()[0].starts_with("Could not read"),
        "{:?}",
        home.failures()
    );
    assert!(
        home.failures()[1].starts_with("Could not change"),
        "{:?}",
        home.failures()
    );
    assert_eq!(
        std::fs::read_to_string(home.path()).expect("the file is there"),
        "{ not json"
    );
}

#[test]
fn two_writers_of_one_file_lose_nothing_of_each_others() {
    let home = Home::new();
    let rounds = 150;
    let writers: Vec<std::thread::JoinHandle<()>> = ["local", "codespace:owner/name"]
        .into_iter()
        .map(|key| {
            // Each its own store, as two processes have.
            let store = home.store();
            std::thread::spawn(move || {
                for n in 0..rounds {
                    store_session(&store, key, &script(&issued(&format!("{key}-{n}")), "r"));
                }
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
    assert!(home.failures().is_empty(), "{:?}", home.failures());
}
