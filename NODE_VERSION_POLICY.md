# Node.js version policy

Flary supports Node.js 22.19.0 and newer maintained Node.js lines.

The minimum version is declared in `package.json`, `.nvmrc`, and the starter packages. Continuous
integration tests the minimum version and the current newer line before release.

Cloudflare Workers execute the deployed runtime. The Node.js requirement applies to local builds,
the CLI, tests, and package installation scripts.

When the minimum version changes, update all policy projections in the same pull request and run the
complete package installation test.
