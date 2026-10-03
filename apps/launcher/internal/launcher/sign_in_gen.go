// Code generated from specs/src/sign-in-store/SignIn.json — DO NOT EDIT.
//
// Regenerate: node scripts/spec/generate-sign-in-go.mjs
// The Rust side (semiont::sign_in_store) generates its entry from the same
// schema.

package launcher

import "time"

// SignIn: One sign-in to a running stack's knowledge base, as the sign-in
// store keeps it: the tokens an issuer issued to the script client, and what
// a renewal and a sign-out need of that issuer, learned once at sign-in.
// TOKENS, never a password. An entry of <stateDir>/tokens.json (see
// README.md).
type SignIn struct {
	// The access token: short-lived, sent as a Bearer token.
	Token string `json:"token"`

	// The refresh token: long-lived, and what renews the access token at the
	// issuer without another sign-in. An entry with none cannot be renewed.
	RefreshToken string `json:"refreshToken,omitempty"`

	// Who signed in: the address the access token named when the sign-in was
	// made, which is the one the gateway answers for it. For display. A writer
	// that renews an entry keeps it.
	Email string `json:"email"`

	// When the access token was issued to this machine, RFC 3339 in UTC.
	ObtainedAt time.Time `json:"obtainedAt"`

	// When the access token stops working, RFC 3339 in UTC, so a reader can
	// renew before sending a token it knows is dead. Absent when the issuer
	// named no lifetime: the gateway's refusal is then the signal.
	ExpiresAt time.Time `json:"expiresAt,omitzero"`

	// The issuer the sign-in came from: the one the access token named when the
	// sign-in was made. A writer that renews an entry keeps it.
	Issuer string `json:"issuer"`

	// The issuer's token endpoint, where the refresh grant is made.
	TokenEndpoint string `json:"tokenEndpoint"`

	// The issuer's revocation endpoint (RFC 7009), where a sign-out tells it to
	// forget the refresh token. Absent when the issuer has none.
	RevocationEndpoint string `json:"revocationEndpoint,omitempty"`
}

// signInRequired: the properties every SignIn states. A member of the
// document that lacks one is not a SignIn.
var signInRequired = []string{"token", "email", "obtainedAt", "issuer", "tokenEndpoint"}
