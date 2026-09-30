# Changelog

All notable changes to Flary are documented in this file.

## 1.0.8 - 2026-09-30

### Added

- Include Shiki syntax highlighting in `FlaryMarkdown` by default, with warm Flary light and dark
  palettes. Language grammars load on demand and highlighting works as answers stream.
- Follow host light/dark themes or the system preference; use `colorScheme` to choose explicitly.
  Preserve custom `shikiTheme` and `plugins.code` overrides.

## 1.0.7 - 2026-09-30

### Changed

- Add file-type badges to Markdown code-block headers, including TypeScript, JavaScript, JSON,
  Markdown, HTML, CSS, shell, and Python. Reduce the header height to keep answers compact.
- Use the Flary flame logo across the website, docs chat, and favicon.
- Tighten the docs chat header and composer, improve text sizing, and simplify connection status.

### Fixed

- Prevent website footer styles from adding empty space below the docs chat composer.
- Make the chat textarea inherit the interface font.
- Restore the cloud workspace adapter's file copy and patch operations.

## 1.0.6 - 2026-09-30

### Changed

- Render assistant Markdown in the React console and docs chat, including streaming answers,
  headings, lists, tables, links, and fenced code blocks with copy buttons.
- Include scoped Markdown styles by default without requiring Tailwind. Export `flaryMarkdownStyles`
  for applications that share one stylesheet across messages.

### Fixed

- Keep incomplete Markdown readable while answers stream and preserve React roots between updates.
- Restore the docs chat after page navigation and create a session before the first message.
- Correct docs-agent tool calls and fetch the current release from npm when asked.
- Remove the colored stripe from the selected docs chat.

## 1.0.5 - 2026-09-29

### Changed

- Update the Flue runtime, SDK, CLI, and Vite integration to 2.2.2. Keep the beta.9 legacy export
  bridge and the canonical session rollback patch.
- Pin new Flue 2 session metadata to the installed 2.2.2 runtime.

## 1.0.4 - 2026-09-29

### Fixed

- Decode internal Flary thread names before parsing approval requests.
- Update the Undici pin used by Flary and its generated templates.

## 1.0.3 - 2026-09-28

### Changed

- Update the Flue runtime, SDK, CLI, and Vite integration to 2.1.1 while retaining the beta.9 legacy
  export bridge and Flary session rollback compatibility patch.
- Simplify local onboarding with `npm run setup`, a four-step installer, saved drafts, clearer
  typography, and progress and recovery messages during deployment.

### Fixed

- Verify existing Cloudflare credentials and show a persistent connected indicator.
- Allow project creation after the installer has saved its initial setup state.

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
