import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const docsRoot = path.join(root, "docs");
const sections = ["Start", "Build", "Connect", "Run", "Operate", "Examples", "Reference"];
const redirects = new Set([
  "getting-started",
  "self-hosting",
  "one-off-agent",
  "prompts",
  "durable-threads",
  "sessions-and-workspaces",
  "workspaces-history",
  "tools-and-mcp",
  "host-neutral-toolsets",
  "providers-and-cache",
  "modes-permissions",
  "cloudflare-resources",
  "production-checklist",
  "channels-and-webhooks",
]);

function files(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? files(file) : entry.name.endsWith(".mdx") ? [file] : [];
  });
}

test("documentation frontmatter uses the normalized navigation", () => {
  const orders = new Set<string>();
  for (const file of files(docsRoot)) {
    const source = fs.readFileSync(file, "utf8");
    const frontmatter = /^---\n([\s\S]*?)\n---/.exec(source)?.[1];
    assert.ok(frontmatter, `${file} has frontmatter`);
    const section = /^section:\s*(.+)$/m.exec(frontmatter)?.[1];
    const order = /^order:\s*(\d+)$/m.exec(frontmatter)?.[1];
    assert.ok(section && sections.includes(section), `${file} uses a known section`);
    assert.ok(order, `${file} has a positive order`);
    const key = `${section}:${order}`;
    assert.ok(!orders.has(key), `duplicate documentation order ${key}`);
    orders.add(key);
  }
});

test("documentation links resolve to a page or a declared redirect", () => {
  const slugs = new Set(
    files(docsRoot).map((file) =>
      path
        .relative(docsRoot, file)
        .replace(/\.mdx$/, "")
        .replaceAll(path.sep, "/"),
    ),
  );
  for (const file of files(docsRoot)) {
    const source = fs.readFileSync(file, "utf8");
    for (const match of source.matchAll(/\]\(\/docs\/([^/)]+(?:\/[^/)]+)*)\/?(?:#[^)]+)?\)/g)) {
      const slug = match[1]!;
      assert.ok(
        slugs.has(slug) || redirects.has(slug),
        `${file} links to missing docs page ${slug}`,
      );
    }
  }
  const astroConfig = fs.readFileSync(path.join(root, "apps/cloud/astro.config.ts"), "utf8");
  for (const slug of redirects) assert.match(astroConfig, new RegExp(`\\/docs\\/${slug}`));
});

test("beginner documentation has no hard-coded release or internal engine setup", () => {
  for (const name of ["quickstart.mdx", "deploy.mdx", "functions.mdx", "agents.mdx", "tools.mdx"]) {
    const source = fs.readFileSync(path.join(docsRoot, name), "utf8");
    assert.doesNotMatch(source, /\b0\.[0-9]+\b|Flue|beta\.?9|unpublished/i, name);
  }
  const layout = fs.readFileSync(
    path.join(root, "apps/cloud/src/layouts/DocsLayout.astro"),
    "utf8",
  );
  assert.match(layout, /packageManifest\.version/);
  assert.doesNotMatch(layout, /docs-version">0\./);
});

test("the coding guide uses the built starter and names the built-in coding tools", () => {
  const guide = fs.readFileSync(path.join(docsRoot, "examples/coding-agent.mdx"), "utf8");
  const tools = fs.readFileSync(path.join(root, "templates/starter/src/tools.ts"), "utf8");
  const coder = fs.readFileSync(path.join(root, "templates/starter/src/coder.ts"), "utf8");
  assert.match(guide, /templates\/starter\/src\/tools\.ts\?raw/);
  assert.match(guide, /workspace\.(?:grep|read)/);
  assert.match(guide, /shell\.exec/);
  assert.match(tools, /app\.workspace\(/);
  assert.match(coder, /subagents:\s*\{\s*reviewer\s*\}/);
});

test("real product examples state their verified integration status", () => {
  const tracked = fs.readFileSync(path.join(docsRoot, "examples/tracked-agent.mdx"), "utf8");
  const florist = fs.readFileSync(path.join(docsRoot, "examples/florist-agent.mdx"), "utf8");
  assert.match(tracked, /verified Flary integration/i);
  assert.match(tracked, /eagerTools:\s*\["stats", "trend"\]/);
  assert.match(florist, /verified Flary integration/i);
  assert.match(florist, /private\s+Cloudflare service binding/i);
  assert.match(florist, /request_user_input/);
  assert.match(florist, /useFlaryThread/);
});

test("the public example picker includes Tracked and the florist pattern", () => {
  const examples = fs.readFileSync(
    path.join(root, "apps/cloud/src/components/CodeExamples.tsx"),
    "utf8",
  );
  assert.match(examples, /id: "tracked"/);
  assert.match(examples, /verified SaaS agent/i);
  assert.match(examples, /id: "florist"/);
  assert.match(examples, /verified Astro and Shopify concierge/i);
  assert.match(examples, /useFlaryThread/);
});
