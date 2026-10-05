# Security Policy

## Supported Versions

Security fixes are provided for **0.5.6 and later**. We recommend running
the latest 0.5.x release.

| Version  | Supported          |
| -------- | ------------------ |
| >= 0.5.6 | :white_check_mark: |
| < 0.5.6  | :x:                |

## Reporting a Vulnerability

Please **do not** open a public GitHub issue for security problems.

Report vulnerabilities privately through GitHub Security Advisories:

- Go to <https://github.com/The-AI-Alliance/semiont/security/advisories/new>
  (the "Report a vulnerability" button on the repository's Security tab).

Please include:

- A description of the vulnerability and its potential impact
- Steps to reproduce
- Affected version(s)
- Suggested fixes, if any

Maintainers will acknowledge your report and respond as soon as possible.
Please allow reasonable time for a fix before any public disclosure.

## Security Documentation

- [Security model & operational hardening](docs/operator/administration/SECURITY.md)
- [Authentication architecture (OAuth + JWT)](docs/operator/administration/AUTHENTICATION.md)
- [Roles & access control (RBAC)](docs/protocol/RBAC.md)
- [Secrets management](docs/operator/services/SECRETS.md)
- [Container image supply-chain (scanning, SBOM, signing)](docs/operator/administration/IMAGES.md)
