## Description

<!-- What this changes and why. Name the issue it closes, e.g. "Fixes #123". -->

## Type of Change

- [ ] Bug fix
- [ ] New feature
- [ ] Breaking change (described under Breaking Changes)
- [ ] Refactoring
- [ ] Performance
- [ ] Security fix
- [ ] Documentation
- [ ] Build, CI or release

## Areas Changed

- [ ] The spec (`specs/`)
- [ ] Gateway (`apps/gateway`)
- [ ] Dispatcher (`apps/dispatcher`)
- [ ] A Node service image (`apps/archivist`, `apps/librarian`, `apps/smelter`, `apps/weaver`, `apps/worker`)
- [ ] Browser (`apps/browser`, `apps/desktop`)
- [ ] Launcher (`apps/launcher`)
- [ ] TypeScript packages (`packages/sdk` and the other npm workspaces under `packages/`)
- [ ] Rust crates (`packages/*-rust`)
- [ ] Go SDK (`packages/sdk-go`)
- [ ] Conformance suites (`tests/conformance`)
- [ ] End-to-end suite (`tests/e2e`)
- [ ] Scripts (`scripts/`)
- [ ] GitHub Actions (`.github/workflows/`)
- [ ] Documentation (`docs/`, `website/`)

## Testing

Check what you ran. CI runs every suite here except the end-to-end one; `docs/contributor/TESTING.md` says what each needs.

- [ ] Tests are added or updated for the behavior this changes
- [ ] npm workspaces: `npm run typecheck`, and `npm test --workspace=<name>` for each one changed
- [ ] Rust: `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D warnings` and `cargo test --workspace`
- [ ] Launcher: `cd apps/launcher && go test -timeout 30m ./...`
- [ ] Go SDK: `cd packages/sdk-go && go test -timeout 5m ./...`
- [ ] Gateway conformance: `cd tests/conformance && npm run test:gateway`
- [ ] Dispatcher conformance: `cd tests/conformance && npm run test:dispatcher`
- [ ] SDK conformance: `cd tests/conformance && npm run test:sdk`
- [ ] End-to-end, against a stack built from this branch: `cd tests/e2e && npm test`
- [ ] `specs/` changed: the generated code committed to the tree is regenerated (the `generated-artifacts` job in `.github/workflows/ci.yml` names a stale file and the command that rewrites it)

## Security

Complete this section if the change touches the gateway's routes, how any part mints, verifies, stores or sends a token, or the Browser's session code. Otherwise delete it. The model is in `docs/operator/administration/SECURITY.md` and `docs/operator/administration/AUTHENTICATION.md`.

- [ ] A new or changed operation is declared in `specs/src/paths/` and says whether it is public (`"security": []`); `npm run lint:spec-protocol` passes
- [ ] A new protected route's handler takes a credential (`Authenticated` or `MediaOrBearer` in `apps/gateway/src/http.rs`); nothing protects a route by default
- [ ] The gateway's one authorization decision stands: authenticated, or 401. No route returns 403 or reads a human role
- [ ] The cases no schema can state are added under `tests/conformance/gateway/`, each citing the text it checks, and `cd tests/conformance && npm run test:gateway` passes
- [ ] A credential travels only as `Authorization: Bearer`, or as `?token=` on `GET /api/resources/{id}`: no cookie, and CORS carries no credentials
- [ ] No token, key or secret reaches a log line, an error body or a committed file
- [ ] Session code (`packages/sdk/src/session/`, `apps/browser/src/contexts/AuthShell.tsx`): `npm test --workspace=@semiont/sdk` and `cd apps/browser && npm run test:security` pass
- [ ] `SECURITY.md` and `AUTHENTICATION.md` describe the result

## Breaking Changes

<!-- "None", or: what breaks (the protocol in specs/, an SDK's public surface, the semiont command, a knowledge base's configuration or stored data) and what someone upgrading has to do. -->

## Documentation

- [ ] `docs/` is updated for the readers this affects (`analyst/`, `builder/`, `operator/`, `contributor/`, `architecture/`, `protocol/`)
- [ ] The README and `docs/` of each app or package changed are updated
- [ ] TypeScript examples in the docs typecheck: `npm run build:packages && ./scripts/compliance/audit-doc-snippets.sh`
