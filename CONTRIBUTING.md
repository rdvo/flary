# Contributing to Flary

Thank you for improving Flary.

## Development setup

Flary uses Node.js 22.19.0 or newer and pnpm 8.15.4. The root `package.json` is the source of truth
for the pnpm version.

```bash
nvm use
pnpm install --frozen-lockfile
```

## Required checks

Run these commands before you open a pull request:

```bash
npm run check
npm run build
npm run package:check
npm test
npm run test:npm-install
```

Use `npm run lint:audit` to review all anti-slop boundary findings. Do not add unchecked casts or
generic safety comments only to silence the audit.

## Source rules

- Keep public behavior in typed contracts and validate external data at its input boundary.
- Keep provider-specific behavior behind provider adapters.
- Keep Cloudflare-specific behavior behind Cloudflare adapters.
- Do not commit generated `.flue`, `.flue-vite`, `dist`, or Wrangler files.
- Add a focused test for each behavior change and failure case.
- Do not add a public export without documenting its compatibility cost.
- Do not include credentials, customer data, or unredacted provider payloads in tests, logs, issues,
  or pull requests.

## Pull requests

Keep each pull request focused. Explain the user-visible effect, compatibility risk, test evidence,
and rollback path. A maintainer must review public API, storage, authentication, secret, and release
changes.

Report security problems by following [SECURITY.md](SECURITY.md). Do not use a public issue for a
suspected vulnerability.
