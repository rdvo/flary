interface RawDoc {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly text: string;
}

// Include every public MDX page. `**` matters here: examples live below
// `docs/examples`, and the assistant must be able to verify those too.
const documentation = import.meta.glob("../../../docs/**/*.mdx", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;

const examples = import.meta.glob("../../../templates/starter/src/*.ts", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;

const readme = import.meta.glob("../../../README.md", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;

export const docsCorpus: readonly RawDoc[] = Object.freeze([
  ...Object.entries(documentation).map(([path, text]) => {
    const id = path
      .split("/")
      .at(-1)!
      .replace(/\.mdx$/, "");
    return {
      id: `docs/${id}`,
      title: frontmatterValue(text, "title") ?? titleCase(id),
      url: `https://docs.flary.dev/docs/${id}/`,
      text,
    };
  }),
  ...Object.entries(examples).map(([path, text]) => {
    const file = path.split("/").at(-1)!;
    return {
      id: `starter/${file}`,
      title: `Starter: ${file}`,
      url: `https://github.com/rdvo/flary/blob/main/templates/starter/src/${file}`,
      text,
    };
  }),
  ...Object.values(readme).map((text) => ({
    id: "readme",
    title: "Flary README",
    url: "https://github.com/rdvo/flary/blob/main/README.md",
    text,
  })),
]);

export const docsReference = docsCorpus
  .map((entry) => [`SOURCE: ${entry.title}`, `URL: ${entry.url}`, entry.text].join("\n"))
  .join("\n\n---\n\n");

function frontmatterValue(text: string, key: string): string | undefined {
  const match = new RegExp(`^${key}:\\s*["']?(.+?)["']?\\s*$`, "m").exec(text);
  return match?.[1];
}

function titleCase(value: string): string {
  return value
    .split("-")
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}
