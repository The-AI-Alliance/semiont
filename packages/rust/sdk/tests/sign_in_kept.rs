//! A sign-in kept in memory (`MemorySignIn`), for as long as the process
//! lives: held until it is forgotten, renewed against what it holds, and
//! naming the person the gateway said its token is, recorded as one step.

use semiont::session::{MemorySignIn, SignInKept, StoredSession, person_key};

fn signed_in(access: &str, refresh: &str) -> StoredSession {
    StoredSession {
        access: access.to_owned(),
        refresh: refresh.to_owned(),
        client_id: "semiont-cli".to_owned(),
        token_endpoint: "https://issuer.test/token".to_owned(),
        revocation_endpoint: None,
        person_key: None,
    }
}

async fn held(kept: &MemorySignIn) -> Option<StoredSession> {
    kept.held().await.expect("held")
}

#[tokio::test]
async fn a_sign_in_kept_in_memory_is_held_until_it_is_forgotten() {
    let kept = MemorySignIn::new();
    assert_eq!(held(&kept).await, None);

    kept.keep(signed_in("a1", "r1")).await.expect("kept");
    assert_eq!(held(&kept).await, Some(signed_in("a1", "r1")));

    // A new sign-in is kept in place of the one before.
    kept.keep(signed_in("b1", "rb")).await.expect("kept");
    assert_eq!(held(&kept).await, Some(signed_in("b1", "rb")));

    kept.forget().await.expect("forgotten");
    assert_eq!(held(&kept).await, None);
    kept.forget().await.expect("forgotten");
    assert_eq!(held(&kept).await, None);
}

/// A renewal is written against what is kept then: one of a sign-in that
/// is no longer the one kept gives what is kept and writes nothing, and one
/// of a sign-in forgotten meanwhile keeps nothing.
#[tokio::test]
async fn a_renewal_kept_in_memory_is_written_against_what_is_kept() {
    let kept = MemorySignIn::new();
    let read = signed_in("a1", "r1");
    kept.keep(read.clone()).await.expect("kept");

    let given = kept.renewed(&read, "a2", "r2").await.expect("renewed");
    assert_eq!(given.as_deref(), Some("a2"));
    assert_eq!(held(&kept).await, Some(signed_in("a2", "r2")));

    let stale = kept.renewed(&read, "a3", "r3").await.expect("renewed");
    assert_eq!(stale.as_deref(), Some("a2"));
    assert_eq!(held(&kept).await, Some(signed_in("a2", "r2")));

    kept.forget().await.expect("forgotten");
    let gone = kept
        .renewed(&signed_in("a2", "r2"), "a4", "r4")
        .await
        .expect("renewed");
    assert_eq!(gone, None);
    assert_eq!(held(&kept).await, None);
}

/// A sign-in kept in memory records the person the gateway named as one
/// step, only while it holds the token that was asked about and names
/// nobody; a renewal keeps the person.
#[tokio::test]
async fn a_sign_in_kept_in_memory_records_the_person_of_the_token_asked_about() {
    let (jo, ann) = (
        person_key("did:web:example.org:users:jo"),
        person_key("did:web:example.org:users:ann"),
    );
    let kept = MemorySignIn::new();
    let on_nothing = kept.record_person_key("a1", &jo).await.expect("asked");
    assert!(!on_nothing, "a person recorded on nothing kept");

    kept.keep(signed_in("a1", "r1")).await.expect("kept");
    for (access, person, recorded) in [
        ("another token", &jo, false),
        ("a1", &jo, true),
        ("a1", &jo, true),
        ("a1", &ann, false),
    ] {
        assert_eq!(
            kept.record_person_key(access, person).await.expect("asked"),
            recorded,
            "recording {person} on the sign-in of {access}"
        );
    }

    let named = held(&kept).await.expect("a sign-in");
    assert_eq!(named.person_key.as_deref(), Some(jo.as_str()));
    let given = kept.renewed(&named, "a2", "r2").await.expect("renewed");
    assert_eq!(given.as_deref(), Some("a2"));
    assert_eq!(
        held(&kept).await,
        Some(StoredSession {
            person_key: Some(jo),
            ..signed_in("a2", "r2")
        })
    );
}
