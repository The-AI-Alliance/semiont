# Secrets Management

Semiont stores secrets in a dedicated file outside the project directory, separate from `~/.semiontconfig`, following XDG conventions.

## Secrets File

**Path**: `$XDG_CONFIG_HOME/semiont/secrets` (default: `~/.config/semiont/secrets`)
**Permissions**: mode 0600 (owner read/write only)
**Format**: TOML

```toml
[secrets]
JWT_SECRET = "..."   # Shared with frontend as NEXTAUTH_SECRET
```

This file is:
- Never committed to version control
- Never synced or backed up by default (unlike `~/.semiontconfig`)
- Generated automatically by `semiont provision` on first run (generates a random JWT secret)
- Read by `semiont start` — secrets are merged into the environment of spawned processes

## JWT Secret

The JWT secret must be identical in both the backend (`JWT_SECRET`) and frontend (`NEXTAUTH_SECRET`). Storing it in the secrets file ensures it persists across re-provisions without ever appearing in a config file that might be synced or accidentally committed.

### First provision
```
semiont provision
# → No secrets file found. Generating JWT secret...
# → Wrote ~/.config/semiont/secrets (mode 0600)
```

### Subsequent provisions
```
semiont provision
# → Secrets file found. Using existing JWT secret.
```

## Future: External Secret Stores

The secrets file can be replaced by an OS keychain or external secrets manager — analogous to `git config --global credential.helper osxkeychain`. Planned support includes:

- macOS Keychain (`osxkeychain`)
- AWS Secrets Manager
- HashiCorp Vault
- 1Password

When an external store is configured, `semiont start` retrieves secrets from it rather than the local file. The secrets file becomes optional.

## Related Documentation

- [Configuration Guide](../administration/CONFIGURATION.md) — Full configuration reference
- [Authentication](../administration/AUTHENTICATION.md) — JWT and OAuth flow
- [AWS Deployment](../platforms/AWS.md) — AWS Secrets Manager setup
