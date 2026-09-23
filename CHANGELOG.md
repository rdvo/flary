# Changelog

All notable changes to Flary are documented in this file.

## 1.0.2 - 2026-09-23

### Added

- Added an authenticated, immutable beta.9 legacy export operation and explicit `doctor` export
  sweep for operator-supplied thread IDs.
- Added deterministic SHA-256 manifests with read-back verification, attachment inventories, and
  idempotent retry/conflict handling.

### Fixed

- Apply dependency patches to hoisted and nested npm copies, with strict errors and version checks.
- Report the pinned Flue 2.1.0 runtime accurately in the session-engine release check.

### Migration

- 1.0.2 is an export-sweep bridge. Keep `@flue/runtime-legacy` beta.9 installed and export every
  idle legacy thread before upgrading to 1.1.0.
- Active and failed threads must be retried. Archives are immutable and digest-verified; a changed
  source never overwrites a completed archive.

## 1.0.1 - 2026-09-01

### Changed

- Added an Oxlint release gate with the vendored anti-slop rules.
- Removed generated build output from source control.
- Standardized package metadata, Node.js policy, and pnpm tooling.
- Added pull-request CI, a security policy, and contributor guidance.
- Simplified build code and removed dead branches and unused values.

### Fixed

- Corrected unsafe optional access found during the release audit.
- Replaced unclear conditional expressions with explicit control flow.
- Removed em dashes from maintained source and documentation text.

## 1.0.0 - 2026-09-01

- First stable Flary release.
- Added durable agent threads, tool search, Code Mode, approvals, user input, secret collection,
  workspaces, provider recovery, and realtime clients.
- Added Cloudflare deployment support and clean starter, dashboard, and mail templates.
