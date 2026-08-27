# Secrets Management

Two kinds of secret reach a running stack, and the launcher treats them
differently: it generates and keeps the backend's token-signing key, and it only
*points at* everything else.

## The backend's JWT secret

`JWT_SECRET` signs and validates bearer tokens. The Browser never sees it — it
holds only the bearer token the backend returns. The backend refuses to start if
it is unset or shorter than 32 characters.

`semiont start` resolves it in this order:

1. `$JWT_SECRET` from the environment, when set
2. the KB root's `jwt-secret` file, mode 0600
3. a freshly generated 64-hex-character value, persisted to that file before use

**Path**: `~/Library/Application Support/semiont/roots/<root>/jwt-secret` on
macOS; `$XDG_DATA_HOME/semiont/roots/<root>/jwt-secret` on Linux
(`~/.local/share/semiont/` when that variable is unset).

Per-root and persistent, both deliberately: the secret signs tokens for the users
in that root's PostgreSQL store, so it shares their lifecycle. A new secret
invalidates every token already issued. An unscoped `semiont clean` removes the
root's state directory and this secret with it — consistent, since the accounts
those tokens name are in the PostgreSQL data being removed. A `--store` clean
keeps it.

`SEMIONT_WORKER_SECRET` (the backend/sidecar agent-token exchange) follows the
opposite rule: generated per run unless you export one, because every consumer is
a container started in that same run and nothing outlives it.

## Config secrets — pointers, not values

Inference API keys and the like are never stored by the launcher. `semiont secret`
registers *where a value comes from* — a `{provider, path}` pointer, machine-wide
in `roots.json` — and every `semiont start` reads it fresh by running the
provider's own CLI with the terminal attached, so its authorization prompt works.

```bash
semiont secret set ANTHROPIC_API_KEY                          # interactive
semiont secret set ANTHROPIC_API_KEY op://OSS/Anthropic/credential
semiont secret list                                           # pointers, never values
semiont secret rm ANTHROPIC_API_KEY
```

Exporting the variable yourself always wins, and is the escape hatch on a machine
with no secret manager installed.

**Providers**: 1Password today — `op://<vault>/<item>/<field>`, requires the `op`
CLI on PATH. The URI scheme selects from a provider registry; supporting an OS
keychain or a cloud secrets manager means adding an entry to it.

### Codespace stacks

A codespace runs on GitHub's machine and cannot reach your local provider, so the
value has to live there too:

```bash
semiont secret push ANTHROPIC_API_KEY --repo owner/name
```

This resolves the pointer, hands the value to `gh` on stdin (never argv), and
*adds* the repo to the secret's existing selection rather than replacing it. It is
the one place the launcher moves a value instead of pointing at one.

## Related Documentation

- [Configuration Guide](../administration/CONFIGURATION.md) — Full configuration reference
- [Authentication](../administration/AUTHENTICATION.md) — JWT and OAuth flow
- [Running Semiont on AWS](../platforms/AWS.md) — unsupported; secrets are your integration
