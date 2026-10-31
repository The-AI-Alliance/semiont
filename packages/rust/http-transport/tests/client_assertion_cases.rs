//! A service account's assertion of itself, held to
//! specs/src/session/client-assertion-cases.json.
//!
//! The table states the shape: the thumbprint a key is named by, and the
//! header and claims an assertion carries. The signature over them, and the
//! form a grant posts, are held in sign_in.rs, where a grant's assertion is
//! checked with the key's public half as an issuer checks it.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use semiont_http_transport::client_assertion::{
    JWT_BEARER, LIFETIME_SECONDS, claims, header, thumbprint,
};
use serde_json::Value;

fn table() -> Value {
    serde_json::from_str(include_str!(
        "../../../../specs/src/session/client-assertion-cases.json"
    ))
    .expect("the table is JSON")
}

fn cases<'a>(table: &'a Value, name: &str) -> &'a [Value] {
    let cases = table[name]
        .as_array()
        .unwrap_or_else(|| panic!("the table has no {name}"));
    assert!(!cases.is_empty(), "the table's {name} are none");
    cases
}

fn text<'a>(case: &'a Value, key: &str) -> &'a str {
    case[key]
        .as_str()
        .unwrap_or_else(|| panic!("{}: no string {key}", case["why"]))
}

/// A case's public key: its modulus and its exponent, big-endian.
fn key_of(case: &Value) -> (Vec<u8>, Vec<u8>) {
    let jwk = &case["jwk"];
    assert_eq!(jwk["kty"], "RSA", "{}: its key is not RSA", case["why"]);
    let number = |member: &str| {
        URL_SAFE_NO_PAD
            .decode(text(jwk, member))
            .unwrap_or_else(|e| panic!("{}: its {member} is not base64url: {e}", case["why"]))
    };
    (number("n"), number("e"))
}

#[test]
fn a_key_is_named_by_its_thumbprint() {
    let table = table();
    for case in cases(&table, "thumbprints") {
        let (n, e) = key_of(case);
        assert_eq!(
            thumbprint(&n, &e),
            text(case, "thumbprint"),
            "{}",
            case["why"]
        );
    }
}

#[test]
fn an_assertion_carries_the_header_and_claims_the_table_states() {
    let table = table();
    for case in cases(&table, "cases") {
        let (n, e) = key_of(case);
        assert_eq!(header(&n, &e), case["header"], "{}", case["why"]);
        let issued_at = case["issuedAt"]
            .as_u64()
            .unwrap_or_else(|| panic!("{}: its issuedAt is not whole seconds", case["why"]));
        let stated = claims(
            text(case, "clientId"),
            text(case, "tokenEndpoint"),
            issued_at,
            text(case, "jti"),
        );
        assert_eq!(stated, case["claims"], "{}", case["why"]);
    }
}

#[test]
fn an_assertion_is_of_the_tables_type_and_lives_as_long_as_it_says() {
    // The form a grant posts is held where a grant is made, in sign_in.rs.
    let table = table();
    assert_eq!(table["assertionType"], JWT_BEARER);
    assert_eq!(table["lifetimeSeconds"], LIFETIME_SECONDS);
}
