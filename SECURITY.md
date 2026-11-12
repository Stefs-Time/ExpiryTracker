# Security policy

VaultExpiry stores personal information: account details, document expiry dates, masked document references, and optionally encrypted photos of identity documents. Please treat security reports accordingly.

## Reporting a vulnerability

- **Don't** open a public issue for a suspected vulnerability.
- Email the maintainer privately (the contact listed for this repository), or use GitHub's **private vulnerability reporting** if it's enabled.
- Include the affected version or commit, steps to reproduce, and the impact. Please avoid accessing other people's data while testing.

You'll get an acknowledgement as soon as possible, and a fix or mitigation plan once the issue is confirmed.

## Supported versions

Only the latest version on the default branch receives security fixes.

## Security design

The full list of controls and accepted risks is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#security-controls). In brief:
- **Passwords and sessions:** Argon2id passwords; server-side sessions (`HttpOnly`, `SameSite=Lax`, `Secure`); login rate limits and account lockout.
- **Request protection:** layered CSRF protection, strict Content Security Policy, parameterised SQL, per-user authorisation (other users' records return 404).
- **Photos:** encrypted at rest (AES-256-GCM, key outside the database), with metadata stripped in the browser and on the server.
- **AI scanning:** consent-based; model output is validated as untrusted input; no document numbers are stored beyond the last 4 digits.
- **Admins:** platform admins can't see vault contents; every admin action is audited.

## Operator responsibilities

Deploying safely also depends on configuration. See the operator checklist in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#operator-checklist-production):
- HTTPS with `NODE_ENV=production`;
- secrets kept only in environment variables;
- `FILE_ENCRYPTION_KEY` stored separately from backups;
- Groq Zero Data Retention turned on if scanning is enabled;
- `ADMIN_PASSWORD` removed after bootstrap.
