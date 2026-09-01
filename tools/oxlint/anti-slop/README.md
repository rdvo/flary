# Anti-slop Oxlint plugin

This directory vendors the generic plugin from
[`dmmulroy/anti-slop`](https://github.com/dmmulroy/anti-slop) at commit
`e8c4880471b23ab7f216fba7b27d173a6ef07d4c`.

The upstream project expects each repository to own and adapt its vendored
rules. Keep `oxlint` and `@oxlint/plugins` on the same exact version. Run
`npm run lint:audit` to see all findings and `npm run lint:strict` to make all
audit warnings fail.
