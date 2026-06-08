# Security Policy

## Supported Versions

Security fixes are provided for the `0.5.x` release line. We recommend
running **0.5.6 or later**, which is the current release in good standing.

| Version | Supported          |
| ------- | ------------------ |
| 0.5.x   | :white_check_mark: |
| < 0.5.x | :x:                |

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

- [Security model & operational hardening](docs/system/administration/SECURITY.md)
- [Authentication architecture (OAuth + JWT)](docs/system/administration/AUTHENTICATION.md)
- [Roles & access control (RBAC)](docs/protocol/RBAC.md)
- [Secrets management](docs/system/services/SECRETS.md)
- [Container image supply-chain (scanning, SBOM, signing)](docs/system/administration/IMAGES.md)
