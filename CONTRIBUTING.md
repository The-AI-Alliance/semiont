# Contributing to Semiont

Thank you for your interest in contributing to Semiont! This document provides guidelines and information for contributors.

## 🎯 Most Valuable Contributions

**We especially welcome contributions that expand platform support!** Semiont currently supports:

- **AWS** - Production deployment on Amazon Web Services
- **POSIX** - Local development on Linux/macOS
- **Container** - Docker/Podman containerized environments
- **External** - Integration with external services
- **Mock** - Testing platform

**High-value platform contributions:**

- Your favorite platform

See [Platform Development Guide](#adding-new-platform-support) for implementation details.

**Alternative frontend implementations:**

We also welcome contributions that bring Semiont to new user interfaces and integration points:

- **Mobile apps** (iOS, Android, React Native)
- **Browser extensions** (Chrome, Firefox, Safari)
- **Desktop applications** (Electron, Tauri)
- **IDE integrations** (VS Code, IntelliJ)

See [apps/frontend/docs/FUTURE.md](apps/frontend/docs/FUTURE.md) for architectural guidance on building alternative frontends that share the core API client and authentication infrastructure.

## 📋 Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [How to Contribute](#how-to-contribute)
- [Development Workflow](#development-workflow)
- [Adding New Platform Support](#adding-new-platform-support)
- [Pull Request Process](#pull-request-process)
- [Commit Guidelines](#commit-guidelines)
- [Testing Requirements](#testing-requirements)
- [Documentation](#documentation)
- [Community](#community)

## 📜 Code of Conduct

This project adheres to the [Code of Conduct](CODE_OF_CONDUCT.md). By participating, you are expected to uphold this code. Please report unacceptable behavior to the project maintainers.

This project is part of [The AI Alliance](https://thealliance.ai/) and follows the [AI Alliance Governance Policy](https://thealliance.ai/governance).

## 🚀 Getting Started

### Prerequisites

- Node.js 18+ with npm
- Git
- Docker or Podman (for container development)
- TypeScript knowledge

### Initial Setup

1. **Fork the repository** on GitHub
2. **Clone your fork**:
   ```bash
   git clone https://github.com/YOUR_USERNAME/semiont.git
   cd semiont
   ```
3. **Install dependencies**:
   ```bash
   npm install
   ```
4. **Set up local environment**:
   ```bash
   export SEMIONT_ENV=local
   semiont init --name "dev-project"
   ```
5. **Run tests** to verify setup:
   ```bash
   npm test
   ```

See [docs/LOCAL-DEVELOPMENT.md](docs/LOCAL-DEVELOPMENT.md) for complete setup instructions.

## 🤝 How to Contribute

### Ways to Contribute

1. **Add platform support** (highest priority - see below)
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
git checkout -b feature/gcp-platform
# or
git checkout -b fix/database-migration-bug
# or
git checkout -b docs/improve-api-reference
```

**Branch naming conventions:**
- `feature/` - New features
- `fix/` - Bug fixes
- `docs/` - Documentation changes
- `test/` - Test improvements
- `refactor/` - Code refactoring
- `platform/` - New platform implementations

### 3. Make Changes

- Follow existing code style and patterns
- Write tests for new functionality
- Update documentation as needed
- Follow [TypeScript strict mode](https://www.typescriptlang.org/tsconfig#strict)

### 4. Test Your Changes

```bash
# Run all tests
npm test

# Run specific service tests
npm run test:backend
npm run test:frontend

# Type check
npm run type-check

# Lint
npm run lint
```

### 5. Commit Changes

Write clear, descriptive commit messages:

```bash
git commit -m "Add GCP deployment support"
git commit -m "Fix database connection timeout in CLI"
git commit -m "Clarify authentication flow in API docs"
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
git push origin feature/gcp-platform
```

Then create a Pull Request from your fork to `The-AI-Alliance/semiont:main` on GitHub.

**For maintainers with push access:** You may push branches directly to the main repository, but pull requests are still required for code review.

## 🌍 Adding New Platform Support

**This is the most valuable contribution you can make!**

Platform contributions enable Semiont to run on new cloud providers and deployment targets. We have comprehensive guides for extending the CLI:

### Developer Guides

- **[Adding Platforms](apps/cli/docs/ADDING_PLATFORMS.md)** - Complete guide to implementing a new platform (GCP, Azure, DigitalOcean, etc.)
- **[Adding Services](apps/cli/docs/ADDING_SERVICES.md)** - Add new service types to the platform
- **[Adding Service Types](apps/cli/docs/ADDING_SERVICE_TYPES.md)** - Extend service type definitions
- **[Adding Commands](apps/cli/docs/ADDING_COMMANDS.md)** - Add new CLI commands

### Quick Overview

1. **Study existing platforms** in `apps/cli/src/platforms/` (AWS, Container, POSIX)
2. **Implement the Platform interface** for your target platform
3. **Add platform-specific resources** and deployment logic
4. **Write tests** for platform operations
5. **Document the platform** in `docs/platforms/YOUR_PLATFORM.md`

Follow the [Adding Platforms guide](apps/cli/docs/ADDING_PLATFORMS.md) for step-by-step instructions.

### Platform PR Checklist

When submitting a new platform:

- [ ] Platform implements complete `Platform` interface
- [ ] Unit tests for platform implementation (>80% coverage)
- [ ] Integration tests for deployment workflow
- [ ] Documentation in `docs/platforms/PLATFORM.md`
- [ ] Updated main [ARCHITECTURE.md](docs/ARCHITECTURE.md) with platform option
- [ ] Example environment configuration
- [ ] Cost estimation guidance
- [ ] Migration guide from existing platforms

### Platform Examples to Follow

Study existing platforms as reference:

- **[AWS](apps/cli/src/platforms/aws/)** - Most complete implementation (ECS, RDS, ALB, CloudFront)
- **[Container](apps/cli/src/platforms/container/)** - Docker/Podman abstraction
- **[POSIX](apps/cli/src/platforms/posix/)** - Local development platform

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
   npm run type-check
   npm run lint
   npm run build
   ```

3. **Update documentation** if you changed APIs or added features

4. **Add tests** for new functionality

### PR Requirements

- ✅ All tests pass
- ✅ TypeScript compiles without errors
- ✅ Code follows existing style
- ✅ Commits follow Conventional Commits format
- ✅ PR description clearly explains changes
- ✅ References related issues (e.g., "Fixes #123")

### PR Template

When creating a PR, include:

```markdown
## Description
Brief description of changes

## Type of Change
- [ ] Bug fix
- [ ] New feature
- [ ] Platform support
- [ ] Documentation
- [ ] Refactoring

## Related Issues
Fixes #123

## Testing
- [ ] Added tests for new functionality
- [ ] All tests pass locally
- [ ] Tested on [platform/environment]

## Documentation
- [ ] Updated relevant documentation
- [ ] Added code comments where needed
```

### Review Process

1. Maintainers will review within 3-5 business days
2. Address review feedback
3. Once approved, maintainers will merge
4. PRs are typically **squash merged** to keep history clean

## 📝 Commit Guidelines

Write clear, descriptive commit messages that explain what changed and why:

**Good commit messages:**

```bash
Add GCP Cloud Run platform support
Fix database connection timeout on slow networks
Update API documentation with authentication examples
Add JWT validation tests for expired tokens
Extract common deployment logic to reduce duplication
```

**Tips:**
- Use imperative mood ("Add feature" not "Added feature")
- Be specific about what changed
- Keep the first line under 72 characters
- Add details in the commit body if needed

## ✅ Testing Requirements

All contributions should include appropriate tests. We have comprehensive testing guides for each component:

### Testing Documentation

- **[System Testing Guide](docs/TESTING.md)** - Overall testing strategy, Vitest, MSW v2, frontend testing
- **[Backend Testing Guide](apps/backend/docs/TESTING.md)** - Jest, unit tests, Prisma database tests
- **[CLI Testing Guide](apps/cli/TESTING.md)** - Platform tests, command tests, mocking

### Quick Start

**Run all tests:**
```bash
npm test
```

**Run service-specific tests:**
```bash
cd apps/backend && npm test     # Backend tests (Jest)
cd apps/frontend && npm test    # Frontend tests (Vitest)
cd apps/cli && npm test         # CLI tests
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

- **System-wide**: `docs/` - Architecture, deployment, testing
- **Backend**: `apps/backend/docs/` - Backend-specific guides
- **Frontend**: `apps/frontend/docs/` - Frontend-specific guides
- **CLI**: `apps/cli/README.md` - CLI usage
- **Platforms**: `docs/platforms/` - Platform-specific deployment

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
- CONTRIBUTORS.md file (when we create one)
- GitHub contributor graphs

## 📄 License

By contributing to Semiont, you agree that your contributions will be licensed under the **Apache License 2.0**.

## 🙏 Thank You

Thank you for contributing to Semiont! Your contributions help make knowledge management and semantic annotation accessible to everyone.

**Questions?** Open a [Discussion](https://github.com/The-AI-Alliance/semiont/discussions) - we're here to help!

---

**Maintainers**: Review [MAINTAINERS.md](MAINTAINERS.md) for merge and release processes (if applicable).
