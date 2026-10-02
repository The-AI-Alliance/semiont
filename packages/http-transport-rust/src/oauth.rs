//! A client as an OAuth public client of the issuer a knowledge base
//! trusts: finding the issuer from the knowledge base's resource metadata
//! (RFC 9728), the authorization-code grant with PKCE (RFC 7636) for an
//! application a person uses, the device authorization grant (RFC 8628) for
//! a process with no browser, the refresh grant, and revocation (RFC 7009).
//!
//! Nothing here names a vendor, and no password passes through it. A client
//! that knows a gateway's address knows everything it needs: the knowledge
//! base names its issuer, and the issuer names its endpoints.
//!
//! **A refusal and an outage are different events.** A `SignInError` that
//! carries a status is the issuer's answer. One that carries none got no
//! answer. A stored session's renewal is tried again only on the second
//! kind, and on an answer that says "not now" (`retry::REFRESH`), inside a
//! bounded budget: a refused grant is final, because trying again only
//! delays a sign-in the person has to perform anyway.

use crate::transport::{HttpTransport, HttpTransportConfig, Timing, why_unanswered};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ring::rand::SecureRandom;
use semiont::errors::{SignInError, SignInErrorCode, TransportError};
use semiont::identity::encode_uri_component;
use semiont::retry::{self, RetryFacts, retry_with_backoff};
use semiont::session::{
    BROWSER_CLIENT_ID, HttpEndpoint, SCRIPT_CLIENT_ID, SIGN_IN_SCOPE, StoredSession, session_key,
};
use semiont::storage::SessionStorage;
use semiont::timing::{HTTP_REQUEST_TIMEOUT, REFRESH_RETRY};
use semiont::transport::{GatewayOperations, Transport};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::time::Duration;
use tokio::sync::watch;
use tokio::time::Instant;

/// Where a sign-in that is under way is remembered.
pub const PENDING_AUTHORIZATION_KEY: &str = "semiont.pendingAuthorization";
const DEVICE_GRANT: &str = "urn:ietf:params:oauth:grant-type:device_code";
/// How long a device code is good for when the issuer does not say.
const DEVICE_CODE_LIFETIME: Duration = Duration::from_secs(600);
/// How often the token endpoint is asked when the issuer does not say, and
/// how much longer it is left between asks each time it says to slow down.
const DEVICE_POLL: Duration = Duration::from_secs(5);

/// An issuer, and the endpoints of it a client uses.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IssuerEndpoints {
    pub issuer: String,
    pub authorization: String,
    pub token: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revocation: Option<String>,
}

fn gateway(target: &HttpEndpoint) -> Result<String, SignInError> {
    target
        .gateway_url()
        .map_err(|invalid| SignInError::new(SignInErrorCode::Discovery, invalid))
}

/// Ask the knowledge base which issuer it trusts, and the issuer where its
/// endpoints are.
pub async fn discover_issuer(
    target: &HttpEndpoint,
    http: &reqwest::Client,
) -> Result<IssuerEndpoints, SignInError> {
    let no_issuer = || {
        SignInError::new(
            SignInErrorCode::NoIssuer,
            "The knowledge base trusts no external issuer",
        )
    };
    // Its resource metadata is public: asked with no token.
    let transport = HttpTransport::new(HttpTransportConfig {
        base_url: gateway(target)?,
        token: watch::channel(None).1,
        refresher: None,
        channels: Some(Vec::new()),
        http: http.clone(),
        timing: Timing::default(),

        bookmarks: None,
    });
    let metadata = transport.get_protected_resource_metadata().await;
    transport.close().await;
    let issuer = match metadata {
        Ok(metadata) => metadata
            .authorization_servers
            .into_iter()
            .next()
            .ok_or_else(no_issuer)?,
        Err(TransportError {
            status: Some(404), ..
        }) => return Err(no_issuer()),
        Err(error) => {
            return Err(SignInError {
                code: SignInErrorCode::Discovery,
                message: format!(
                    "The knowledge base did not answer its resource metadata: {error}"
                ),
                status: error.status,
            });
        }
    };

    let url = format!(
        "{}/.well-known/openid-configuration",
        issuer.trim_end_matches('/')
    );
    let response = http
        .get(&url)
        .header("accept", "application/json")
        .timeout(HTTP_REQUEST_TIMEOUT)
        .send()
        .await
        .map_err(|e| {
            SignInError::new(
                SignInErrorCode::Discovery,
                format!(
                    "Issuer {issuer}: discovery was not answered{}",
                    why_unanswered(&e)
                ),
            )
        })?;
    let status = response.status().as_u16();
    if !response.status().is_success() {
        return Err(SignInError::answered(
            SignInErrorCode::Discovery,
            format!("Issuer {issuer}: discovery answered HTTP {status}"),
            status,
        ));
    }
    let document: Value = response.json().await.unwrap_or(Value::Null);
    let endpoint = |name: &str| document[name].as_str().map(str::to_owned);
    match (
        document["issuer"].as_str() == Some(issuer.as_str()),
        endpoint("authorization_endpoint"),
        endpoint("token_endpoint"),
    ) {
        (true, Some(authorization), Some(token)) => Ok(IssuerEndpoints {
            authorization,
            token,
            device: endpoint("device_authorization_endpoint"),
            revocation: endpoint("revocation_endpoint"),
            issuer,
        }),
        _ => Err(SignInError::answered(
            SignInErrorCode::Discovery,
            format!(
                "Issuer {issuer}: its discovery document is not an OpenID configuration for it"
            ),
            status,
        )),
    }
}

// ── PKCE ────────────────────────────────────────────────────────────────

fn random_url_safe(bytes: usize) -> Result<String, SignInError> {
    let mut buffer = vec![0u8; bytes];
    ring::rand::SystemRandom::new()
        .fill(&mut buffer)
        .map_err(|_| {
            SignInError::new(
                SignInErrorCode::Exchange,
                "The system gave no randomness to begin a sign-in with",
            )
        })?;
    Ok(URL_SAFE_NO_PAD.encode(buffer))
}

/// RFC 7636 §4.2: BASE64URL(SHA-256(verifier)).
pub fn code_challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(ring::digest::digest(
        &ring::digest::SHA256,
        verifier.as_bytes(),
    ))
}

// ── The authorization-code grant ────────────────────────────────────────

/// What a sign-in remembers across the trip to the issuer and back: the
/// verifier and the state the response must match, where the person was
/// connecting, what they believed they were connecting to, and the issuer's
/// endpoints, so its completion asks nothing twice.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingAuthorization {
    pub state: String,
    pub verifier: String,
    pub redirect_uri: String,
    pub target: HttpEndpoint,
    pub issuer: IssuerEndpoints,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kb_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_did: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BeginAuthorization {
    pub target: HttpEndpoint,
    /// Where the issuer sends the person back to. The issuer accepts only an
    /// address its registration of the client lists.
    pub redirect_uri: String,
    /// The registered knowledge base being signed in to again, when it is one.
    pub kb_id: Option<String>,
    /// What the person believed they clicked: checked afterwards, never assumed.
    pub expected_did: Option<String>,
    pub expected_name: Option<String>,
}

fn query(pairs: &[(&str, &str)]) -> String {
    pairs
        .iter()
        .map(|(name, value)| format!("{name}={}", encode_uri_component(value)))
        .collect::<Vec<_>>()
        .join("&")
}

/// Begin the authorization-code grant: find the issuer, remember the pending
/// sign-in in `pending`, and give the URL to send the person to. Sending
/// them is the host's act.
pub async fn begin_authorization(
    options: BeginAuthorization,
    pending: &dyn SessionStorage,
    http: &reqwest::Client,
) -> Result<String, SignInError> {
    let issuer = discover_issuer(&options.target, http).await?;
    let record = PendingAuthorization {
        state: random_url_safe(24)?,
        verifier: random_url_safe(48)?,
        redirect_uri: options.redirect_uri,
        target: options.target,
        issuer,
        kb_id: options.kb_id,
        expected_did: options.expected_did,
        expected_name: options.expected_name,
    };
    // A struct of strings and numbers always serializes.
    pending.set(
        PENDING_AUTHORIZATION_KEY,
        &serde_json::to_string(&record).unwrap_or_default(),
    );
    let asked = query(&[
        ("response_type", "code"),
        ("client_id", BROWSER_CLIENT_ID),
        ("redirect_uri", &record.redirect_uri),
        ("scope", SIGN_IN_SCOPE),
        ("state", &record.state),
        ("code_challenge", &code_challenge(&record.verifier)),
        ("code_challenge_method", "S256"),
    ]);
    let joiner = if record.issuer.authorization.contains('?') {
        '&'
    } else {
        '?'
    };
    Ok(format!("{}{joiner}{asked}", record.issuer.authorization))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IssuedTokens {
    pub access: String,
    pub refresh: String,
}

/// Finish the authorization-code grant from the URL the issuer sent the
/// person back to. The pending record is taken before anything else
/// happens: a code is good once, and a callback that is replayed finds
/// nothing to complete.
pub async fn complete_authorization(
    callback_url: &str,
    pending: &dyn SessionStorage,
    http: &reqwest::Client,
) -> Result<(PendingAuthorization, IssuedTokens), SignInError> {
    let mut taken = None;
    pending.update(PENDING_AUTHORIZATION_KEY, &mut |stored| {
        taken = stored.map(str::to_owned);
        None
    });
    let record: PendingAuthorization = taken
        .and_then(|stored| serde_json::from_str(&stored).ok())
        .ok_or_else(|| {
            SignInError::new(SignInErrorCode::NoPending, "No sign-in is pending here")
        })?;

    let url = reqwest::Url::parse(callback_url).map_err(|e| {
        SignInError::new(
            SignInErrorCode::Exchange,
            format!("The sign-in response is not a URL: {e}"),
        )
    })?;
    let said = |name: &str| {
        url.query_pairs()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.into_owned())
    };
    if let Some(error) = said("error") {
        return Err(SignInError::new(
            if error == "access_denied" {
                SignInErrorCode::Denied
            } else {
                SignInErrorCode::Exchange
            },
            said("error_description").unwrap_or(error),
        ));
    }
    if said("state").as_deref() != Some(record.state.as_str()) {
        return Err(SignInError::new(
            SignInErrorCode::State,
            "The sign-in response does not belong to the pending sign-in",
        ));
    }
    let code = said("code").ok_or_else(|| {
        SignInError::new(
            SignInErrorCode::Exchange,
            "The sign-in response carries no authorization code",
        )
    })?;

    let granted = token_grant(
        http,
        &record.issuer.token,
        &[
            ("grant_type", "authorization_code"),
            ("code", &code),
            ("redirect_uri", &record.redirect_uri),
            ("client_id", BROWSER_CLIENT_ID),
            ("code_verifier", &record.verifier),
        ],
    )
    .await?;
    let refresh = granted.refresh.ok_or_else(no_refresh_token)?;
    Ok((
        record,
        IssuedTokens {
            access: granted.access,
            refresh,
        },
    ))
}

fn no_refresh_token() -> SignInError {
    SignInError::new(
        SignInErrorCode::Exchange,
        "The issuer returned no refresh token: the session could not outlive its first access token",
    )
}

// ── The token endpoint ──────────────────────────────────────────────────

/// One form posted to the issuer: the status it answered, and its answer
/// when that was a JSON object. No answer at all is an error with no status,
/// and so is one that has not come by the request's deadline: an issuer that
/// accepts a connection and never answers would otherwise hold a renewal,
/// and the session waiting on it, for as long as the process lives.
async fn post_form(
    http: &reqwest::Client,
    endpoint: &str,
    form: &[(&str, &str)],
) -> Result<(u16, Option<Map<String, Value>>), SignInError> {
    let response = http
        .post(endpoint)
        .header("content-type", "application/x-www-form-urlencoded")
        .header("accept", "application/json")
        .body(query(form))
        .timeout(HTTP_REQUEST_TIMEOUT)
        .send()
        .await
        .map_err(|e| {
            SignInError::new(
                SignInErrorCode::Exchange,
                format!("The issuer did not answer{}", why_unanswered(&e)),
            )
        })?;
    let status = response.status().as_u16();
    let body = match response.json::<Value>().await {
        Ok(Value::Object(body)) => Some(body),
        _ => None,
    };
    Ok((status, body))
}

fn text<'a>(body: &'a Option<Map<String, Value>>, name: &str) -> Option<&'a str> {
    body.as_ref()?.get(name)?.as_str()
}

/// What the issuer said of a refusal: its error and description, or the status.
fn refusal(status: u16, body: &Option<Map<String, Value>>) -> String {
    match (text(body, "error"), text(body, "error_description")) {
        (Some(error), Some(description)) => format!("{error}: {description}"),
        (Some(error), None) => error.to_owned(),
        (None, _) => format!("HTTP {status}"),
    }
}

struct Granted {
    access: String,
    refresh: Option<String>,
}

async fn token_grant(
    http: &reqwest::Client,
    endpoint: &str,
    form: &[(&str, &str)],
) -> Result<Granted, SignInError> {
    let (status, body) = post_form(http, endpoint, form).await?;
    match (status, text(&body, "access_token")) {
        (200, Some(access)) => Ok(Granted {
            access: access.to_owned(),
            refresh: text(&body, "refresh_token").map(str::to_owned),
        }),
        _ => Err(SignInError::answered(
            SignInErrorCode::Exchange,
            format!(
                "The issuer refused the token request ({})",
                refusal(status, &body)
            ),
            status,
        )),
    }
}

/// The refresh grant. An issuer that does not rotate refresh tokens returns
/// none, and the one held stays current.
pub async fn refresh_at_issuer(
    http: &reqwest::Client,
    token_endpoint: &str,
    client_id: &str,
    refresh_token: &str,
) -> Result<IssuedTokens, SignInError> {
    let granted = token_grant(
        http,
        token_endpoint,
        &[
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token),
            ("client_id", client_id),
        ],
    )
    .await?;
    Ok(IssuedTokens {
        access: granted.access,
        refresh: granted.refresh.unwrap_or_else(|| refresh_token.to_owned()),
    })
}

/// Renew a stored session at its issuer and keep what it rotated. The new
/// access token; nothing when no session is stored, which is an absence and
/// not a failure. A renewal that fails says why in the issuer's own words,
/// and, when the retry budget ran out, how many attempts it took to give up.
///
/// What is kept is written against what is stored then: a session that was
/// signed out while it was being renewed is not written back.
pub async fn refresh_stored_session(
    storage: &dyn SessionStorage,
    kb_id: &str,
    http: &reqwest::Client,
) -> Result<Option<String>, SignInError> {
    let Some(stored) = semiont::session::stored_session(storage, kb_id) else {
        return Ok(None);
    };
    let mut attempts = 0;
    let renewed = retry_with_backoff(
        REFRESH_RETRY,
        || {
            attempts += 1;
            refresh_at_issuer(
                http,
                &stored.token_endpoint,
                &stored.client_id,
                &stored.refresh,
            )
        },
        |error: &SignInError| {
            retry::REFRESH.retryable(&RetryFacts {
                status: error.status,
                method: Some("POST"),
            })
        },
        |_| None,
    )
    .await;
    match renewed {
        Ok(tokens) => {
            storage.update(&session_key(kb_id), &mut |current| {
                StoredSession::read(current?).map(|current| {
                    StoredSession {
                        access: tokens.access.clone(),
                        refresh: tokens.refresh.clone(),
                        ..current
                    }
                    .written()
                })
            });
            Ok(Some(tokens.access))
        }
        // One attempt: the issuer answered, and its answer was final.
        Err(error) if attempts <= 1 => Err(error),
        Err(error) => Err(SignInError {
            code: SignInErrorCode::Exchange,
            message: format!("The session could not be renewed after {attempts} attempts: {error}"),
            status: error.status,
        }),
    }
}

/// RFC 7009. The issuer answers 200 for a token it has already forgotten,
/// so revoking twice is revoking once.
pub async fn revoke_at_issuer(
    http: &reqwest::Client,
    revocation_endpoint: &str,
    client_id: &str,
    refresh_token: &str,
) -> Result<(), SignInError> {
    let (status, _) = post_form(
        http,
        revocation_endpoint,
        &[
            ("token", refresh_token),
            ("token_type_hint", "refresh_token"),
            ("client_id", client_id),
        ],
    )
    .await?;
    if status == 200 {
        Ok(())
    } else {
        Err(SignInError::answered(
            SignInErrorCode::Exchange,
            format!("The issuer refused the revocation (HTTP {status})"),
            status,
        ))
    }
}

// ── The device authorization grant ──────────────────────────────────────

/// What a person is shown to approve a sign-in from wherever they have a
/// browser.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceCode {
    pub user_code: String,
    pub verification_uri: String,
    pub verification_uri_complete: Option<String>,
    pub expires_in: Duration,
}

/// Sign in as a person from a process with no browser: the issuer mints a
/// code, `on_code` shows the person where to approve it, and the token
/// endpoint is asked at the issuer's interval until the tokens arrive.
/// Dropping the future abandons the sign-in.
pub async fn sign_in_with_device_grant(
    target: &HttpEndpoint,
    on_code: impl FnOnce(DeviceCode),
    http: &reqwest::Client,
) -> Result<(IssuerEndpoints, IssuedTokens), SignInError> {
    let issuer = discover_issuer(target, http).await?;
    let Some(device) = issuer.device.clone() else {
        return Err(SignInError::new(
            SignInErrorCode::Discovery,
            format!(
                "Issuer {} offers no device authorization endpoint: the device grant needs one enabled for client {SCRIPT_CLIENT_ID}",
                issuer.issuer
            ),
        ));
    };
    let (status, body) = post_form(
        http,
        &device,
        &[("client_id", SCRIPT_CLIENT_ID), ("scope", SIGN_IN_SCOPE)],
    )
    .await?;
    let (Some(device_code), Some(user_code), Some(verification_uri)) = (
        text(&body, "device_code").filter(|_| status == 200),
        text(&body, "user_code"),
        text(&body, "verification_uri"),
    ) else {
        return Err(SignInError::answered(
            SignInErrorCode::Exchange,
            format!(
                "The issuer refused the device authorization request ({})",
                refusal(status, &body)
            ),
            status,
        ));
    };
    let seconds = |name: &str| {
        body.as_ref()
            .and_then(|body| body.get(name))
            .and_then(Value::as_f64)
            .filter(|seconds| seconds.is_finite() && *seconds >= 0.0)
            .map(Duration::from_secs_f64)
    };
    let expires_in = seconds("expires_in").unwrap_or(DEVICE_CODE_LIFETIME);
    on_code(DeviceCode {
        user_code: user_code.to_owned(),
        verification_uri: verification_uri.to_owned(),
        verification_uri_complete: text(&body, "verification_uri_complete").map(str::to_owned),
        expires_in,
    });

    let expired = || {
        SignInError::new(
            SignInErrorCode::Expired,
            "The code expired before it was approved",
        )
    };
    let mut interval = seconds("interval")
        .unwrap_or(DEVICE_POLL)
        .max(Duration::from_secs(1));
    let deadline = Instant::now() + expires_in;
    loop {
        tokio::time::sleep(interval).await;
        if Instant::now() > deadline {
            return Err(expired());
        }
        let (status, answer) = post_form(
            http,
            &issuer.token,
            &[
                ("grant_type", DEVICE_GRANT),
                ("device_code", device_code),
                ("client_id", SCRIPT_CLIENT_ID),
            ],
        )
        .await?;
        if let (200, Some(access)) = (status, text(&answer, "access_token")) {
            let refresh = text(&answer, "refresh_token").ok_or_else(no_refresh_token)?;
            return Ok((
                issuer,
                IssuedTokens {
                    access: access.to_owned(),
                    refresh: refresh.to_owned(),
                },
            ));
        }
        match text(&answer, "error") {
            Some("authorization_pending") => {}
            Some("slow_down") => interval += DEVICE_POLL,
            Some("access_denied") => {
                return Err(SignInError::answered(
                    SignInErrorCode::Denied,
                    "The sign-in was denied at the issuer",
                    status,
                ));
            }
            Some("expired_token") => return Err(expired()),
            _ => {
                return Err(SignInError::answered(
                    SignInErrorCode::Exchange,
                    format!(
                        "The issuer refused the token request ({})",
                        refusal(status, &answer)
                    ),
                    status,
                ));
            }
        }
    }
}
