// Code generated from specs/src/session/oauth.json — DO NOT EDIT.
//
// Regenerate: node scripts/spec/generate-oauth-clients-go.mjs
// The TypeScript (packages/typescript/core/src/generated/oauth-clients.ts), Rust
// (packages/rust/sdk/build.rs) and Python (semiont.oauth_clients) SDKs generate
// from the same file.

package semiont

// BrowserClientID: An application a person uses: the authorization-code grant
// with PKCE (RFC 7636), at a redirect address the registration lists.
const BrowserClientID = "semiont-browser"

// ScriptClientID: A process with no browser of its own, and the launcher: the
// device authorization grant (RFC 8628).
const ScriptClientID = "semiont-cli"

// SignInScope: What every sign-in asks for. `offline_access` asks for a
// refresh token that outlives the issuer's own browser session: a session
// with a knowledge base is renewed for weeks, not minutes.
const SignInScope = "openid email profile offline_access"
