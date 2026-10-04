# Contributing to Semiont

Thank you for your interest in contributing to Semiont! This document provides guidelines and information for contributors.

## 🎯 Most Valuable Contributions

**We especially welcome contributions that make Semiont run well in more places.** A stack is a set of container images, brought up by the [`semiont` launcher](apps/launcher/README.md):

- **Locally**, against Apple Container, Docker or Podman, on macOS, Linux and Windows
- **In GitHub Codespaces**, where the codespace's own launcher runs the stack
- **On a platform of your own**, where you schedule the images yourself: Kubernetes, OpenShift, a cloud's container service, or machines on your own premises

**High-value contributions here:**

- **The launcher** (Go, `apps/launcher/`): how stacks are started, configured and inspected
- **A worked deployment for a platform**: manifests, a chart or a playbook that satisfies [what the platform must provide](docs/operator/administration/DEPLOYMENT.md#your-own-platform)
- **A driver** for a graph, a vector store, an inference provider or an embedding provider the code does not have yet, written against [its interface](docs/operator/administration/DEPLOYMENT.md#adapting-a-stack)

There is no per-platform plug-in to write. See [Deployment Targets](#-deployment-targets).

**Alternative Browser implementations:**

We also welcome contributions that bring Semiont to new user interfaces and integration points. The web [Browser](apps/browser/README.md) and its [desktop build](apps/desktop/README.md) are shipped. Open to contribution:

- **Mobile apps** (iOS, Android, React Native)
- **Browser extensions** (Chrome, Firefox, Safari)
- **IDE integrations** (VS Code, IntelliJ)

Each is a client of a knowledge base, built on the SDK. Start at [docs/builder](docs/builder/README.md), which covers the TypeScript and Rust SDKs and the embeddable React components.

## 📋 Table of Contents

- [Code of Conduct](#-code-of-conduct)
- [Getting Started](#-getting-started)
- [How to Contribute](#-how-to-contribute)
- [Development Workflow](#-development-workflow)
- [Deployment Targets](#-deployment-targets)
- [Pull Request Process](#-pull-request-process)
- [Commit Guidelines](#-commit-guidelines)
- [Testing Requirements](#-testing-requirements)
- [Documentation](#-documentation)
- [Community](#-community)

## 📜 Code of Conduct

This project adheres to the [Code of Conduct](CODE_OF_CONDUCT.md). By participating, you are expected to uphold this code. Please report unacceptable behavior to the project maintainers.

This project is part of [The AI Alliance](https://thealliance.ai/) and follows the [AI Alliance Governance Policy](https://thealliance.ai/governance).

## 🚀 Getting Started

### Prerequisites

- Git
- A container runtime: Apple Container, Docker or Podman

That is enough: [`scripts/ci/local-build.sh`](scripts/ci/local-build.sh) builds every package, every image and the launcher inside containers. To run the tools directly on your machine you also need Node.js 24, and for the Rust and Go parts the toolchains that [`rust-toolchain.toml`](rust-toolchain.toml) and each `go.mod` name.

### Initial Setup

1. **Fork the repository** on GitHub
2. **Clone your fork**:
   ```bash
   git clone https://github.com/YOUR_USERNAME/semiont.git
   cd semiont
   ```
3. **Get a knowledge base to develop against**, in a separate directory:
   ```bash
   git clone https://github.com/The-AI-Alliance/semiont-template-kb.git
   ```
4. **Build your tree and run a stack on it**:
   ```bash
   ./scripts/ci/local-build.sh
   cd ../semiont-template-kb
   SEMIONT_VERSION=local ../semiont/apps/launcher/dist/semiont start
   ```
5. **Run the tests** for the part you are changing:
   ```bash
   npm ci --include=optional
   npm run build:packages
   npm test --workspace=@semiont/sdk
   ```

[docs/contributor](docs/contributor/README.md) has the orientation: where the code lives, [local development](docs/contributor/LOCAL-DEVELOPMENT.md), [testing](docs/contributor/TESTING.md), [dependencies](docs/contributor/DEPENDENCIES.md) and [releasing](docs/contributor/RELEASE.md).

## 🤝 How to Contribute

### Ways to Contribute

1. **Make Semiont run well in more places** (see [Most Valuable Contributions](#-most-valuable-contributions))
2. **Fix bugs** - Check [Issues](https://github.com/The-AI-Alliance/semiont/issues)
3. **Improve documentation** - Clarify, expand, or fix docs
4. **Write tests** - Increase coverage
5. **Review pull requests** - Help review community contributions
6. **Report bugs** - Create detailed issue reports
7. **Suggest features** - Start a [Discussion](https://github.com/The-AI-Alliance/semiont/discussions)

### Before Starting Work

**For major features or platforms:**
1. Open a [GitHub Discussion](https://github.com/The-AI-Alliance/semiont/discussions) to discuss the approach
2. Get feedback from maintainers before investing significant time
3. Create an issue to track the work

**For bug fixes and small improvements:**
- Search existing issues to avoid duplicates
- Create an issue describing the problem
- Reference the issue in your PR

## 🛠 Development Workflow

**Most contributors will work from a fork.** Only a small number of maintainers have direct push access to the main repository.

### 1. Work in Your Fork

If you haven't already forked the repository (see [Initial Setup](#initial-setup) above):

```bash
# Fork on GitHub, then clone your fork
git clone https://github.com/YOUR_USERNAME/semiont.git
cd semiont

# Add upstream remote to track main repository
git remote add upstream https://github.com/The-AI-Alliance/semiont.git
```

### 2. Create a Branch

Create a feature branch in your fork:

```bash
git checkout -b feature/openshift-manifests
# or
git checkout -b fix/stream-reconnect
# or
git checkout -b docs/improve-api-reference
```

**Branch naming conventions:**
- `feature/` - New features
- `fix/` - Bug fixes
- `docs/` - Documentation changes
- `test/` - Test improvements
- `refactor/` - Code refactoring

### 3. Make Changes

- Follow existing code style and patterns
- Write tests for new functionality
- Update documentation as needed
- Follow [TypeScript strict mode](https://www.typescriptlang.org/tsconfig#strict)

### 4. Test Your Changes

```bash
# Run all tests
npm test

# Run one workspace's tests
npm test -w semiont-browser

# The gateway (Rust): its own checks, then the conformance suite
cargo fmt --all --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace && cargo build --release -p semiont-gateway
(cd tests/conformance && npm run test:gateway)

# The dispatcher, black-box, behind that gateway (needs cargo build --release -p semiont-dispatcher)
(cd tests/conformance && npm run test:dispatcher)

# The SDKs, black-box, as clients of that gateway (needs cargo build --release -p semiont-conformance-drivers and npm run build:packages)
(cd tests/conformance && npm run test:sdk)

# Type check
npm run typecheck
```

CI also runs the `lint:*` gates and the compliance audits; [Testing](docs/contributor/TESTING.md#continuous-integration) lists every job.

### 5. Commit Changes

Write clear, descriptive commit messages:

```bash
git commit -m "Add OpenShift manifests for the service images"
git commit -m "Fix stream reconnect after a gateway restart"
git commit -m "Clarify the sign-in flow in the SDK guide"
```

### 6. Sync with Upstream

Before pushing, sync with the main repository:

```bash
git fetch upstream
git rebase upstream/main
```

### 7. Push to Your Fork and Create PR

```bash
# Push to your fork
git push origin feature/openshift-manifests
```

Then create a Pull Request from your fork to `The-AI-Alliance/semiont:main` on GitHub.

**For maintainers with push access:** You may push branches directly to the main repository, but pull requests are still required for code review.

## 🌍 Deployment Targets

Semiont ships as container images (listed once, in
[the service catalog](docs/operator/services/OVERVIEW.md)) plus the
infrastructure a stack needs. There is no per-platform plugin system.

Stacks are brought up by the host-installed [`semiont` launcher](apps/launcher/README.md), on a laptop or in a
GitHub Codespace. Running the images on a platform of your own (Kubernetes, OpenShift, a cloud's
container service, machines on your own premises) needs no code here: see
[Deploying Semiont](docs/operator/administration/DEPLOYMENT.md) for the three ways to run a stack and
what a platform must provide.

If you want to improve how stacks are launched, the launcher (Go, `apps/launcher/`) is the place.

## 🔄 Pull Request Process

### Before Submitting

1. **Update your fork**:
   ```bash
   git remote add upstream https://github.com/The-AI-Alliance/semiont.git
   git fetch upstream
   git rebase upstream/main
   ```

2. **Run all checks**:
   ```bash
   npm test
   npm run typecheck
   npm run build
   ```

3. **Update documentation** if you changed APIs or added features

4. **Add tests** for new functionality

### PR Requirements

- ✅ All tests pass
- ✅ TypeScript compiles without errors
- ✅ Code follows existing style
- ✅ PR description clearly explains changes
- ✅ References related issues (e.g., "Fixes #123")

### PR Template

GitHub fills a new pull request with [the template](.github/pull_request_template.md). Complete the parts that apply to your change.

### Review Process

1. Maintainers will review within 3-5 business days
2. Address review feedback
3. Once approved, maintainers will merge
4. PRs are typically **squash merged** to keep history clean

## 📝 Commit Guidelines

Write clear, descriptive commit messages that explain what changed and why:

**Good commit messages:**

```bash
Add OpenShift manifests for the service images
Fix stream reconnect after a gateway restart
Update the SDK guide with sign-in examples
Add conformance cases for expired tokens
Extract the shared retry rule into one function
```

**Tips:**
- Use imperative mood ("Add feature" not "Added feature")
- Be specific about what changed
- Keep the first line under 72 characters
- Add details in the commit body if needed

## ✅ Testing Requirements

All contributions should include appropriate tests. We have comprehensive testing guides for each component:

### Testing Documentation

- **[System Testing Guide](docs/contributor/TESTING.md)** - How every suite is configured and run, the SDK's test doubles, end-to-end, CI
- **[Gateway Testing Guide](apps/gateway/docs/TESTING.md)** - The black-box conformance suite and what each check covers

### Quick Start

**Run all tests:**
```bash
npm test
```

**Run service-specific tests:**
```bash
cd apps/browser && npm test                 # Browser suite
cd tests/conformance && npm run test:gateway    # The gateway, black-box (needs `cargo build --release -p semiont-gateway` at the repository root, and nats-server)
cd tests/conformance && npm run test:dispatcher # The dispatcher, black-box (needs the gateway and the dispatcher built, and nats-server)
cd tests/conformance && npm run test:sdk        # Every SDK, black-box, as a client of the gateway (needs the gateway and the Rust drivers built, npm run build:packages, and nats-server)
```

### Test Requirements for PRs

- ✅ All existing tests must pass
- ✅ New functionality must include tests
- ✅ Aim for >80% coverage on new code
- ✅ Tests should be isolated and independent
- ✅ Include both success and error cases

See the testing guides above for detailed patterns and best practices.

## 📚 Documentation

### When to Update Documentation

Update docs when you:

- Add new features
- Change APIs or interfaces
- Add platform support
- Fix bugs that weren't documented
- Improve existing functionality

### Documentation Locations

`docs/` is organized by reader ([docs/README.md](docs/README.md)):

- **`docs/analyst/`**: working in a knowledge base, in the Browser
- **`docs/builder/`**: building on the SDKs
- **`docs/operator/`**: running a stack
- **`docs/contributor/`**: changing Semiont itself
- **`docs/architecture/`** and **`docs/protocol/`**: how Semiont works, and what its parts agree on

How one app or package is built inside stays with it: `apps/<app>/docs/`, `packages/<package>/docs/`, and each one's README. The launcher's manual is `apps/launcher/README.md`.

Code in the docs is typechecked by CI, so an example has to compile ([`tests/doc-snippets`](tests/doc-snippets/)).

### Documentation Style

- Use clear, concise language
- Include code examples
- Add diagrams for complex flows (Mermaid)
- Link to related documentation
- Keep README files brief, link to detailed docs

## 💬 Community

### Getting Help

- **Questions**: [GitHub Discussions](https://github.com/The-AI-Alliance/semiont/discussions)
- **Bugs**: [GitHub Issues](https://github.com/The-AI-Alliance/semiont/issues)
- **Features**: [GitHub Discussions - Ideas](https://github.com/The-AI-Alliance/semiont/discussions/categories/ideas)

### Discussion Categories

- **Ideas** - Feature proposals and platform suggestions
- **Q&A** - Questions about using Semiont
- **Show and Tell** - Share your deployments or platform implementations
- **General** - Other discussions

### Staying Updated

- Watch the repository for updates
- Follow release notes
- Join discussions on major changes

## 🏆 Recognition

Contributors are recognized in:

- Release notes
- GitHub contributor graphs

## 📄 License

By contributing to Semiont, you agree that your contributions will be licensed under the **Apache License 2.0**.

## 🙏 Thank You

Thank you for contributing to Semiont! Your contributions help make knowledge management and semantic annotation accessible to everyone.

**Questions?** Open a [Discussion](https://github.com/The-AI-Alliance/semiont/discussions) - we're here to help!
