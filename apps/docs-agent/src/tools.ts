import { z } from "flary";

import { app } from "./flary";
import { docsCorpus } from "./corpus";

const resultSchema = z.object({
  id: z.string(),
  title: z.string(),
  url: z.string().url(),
  excerpt: z.string(),
});

export const searchFlary = app.fn({
  description: "Search Flary documentation and the public starter source.",
  input: z.object({ query: z.string().trim().min(1).max(200) }),
  output: z.array(resultSchema).max(6),
  policy: {
    operation: "read",
    capabilities: ["docs.read"],
  },
  run: ({ query }) => {
    const terms = tokens(query);
    return docsCorpus
      .map((entry) => ({ entry, score: score(entry, terms) }))
      .filter((candidate) => candidate.score > 0)
      .sort((left, right) => right.score - left.score || left.entry.id.localeCompare(right.entry.id))
      .slice(0, 6)
      .map(({ entry }) => ({
        id: entry.id,
        title: entry.title,
        url: entry.url,
        excerpt: excerpt(entry.text, terms),
      }));
  },
});

export const openFlarySource = app.fn({
  description: "Open one Flary documentation page or public starter source returned by search.",
  input: z.object({ id: z.string().trim().min(1).max(200) }),
  output: resultSchema,
  policy: {
    operation: "read",
    capabilities: ["docs.read"],
  },
  run: ({ id }) => {
    const entry = docsCorpus.find((candidate) => candidate.id === id);
    if (!entry) throw new Error("The requested Flary source was not found.");
    return {
      id: entry.id,
      title: entry.title,
      url: entry.url,
      excerpt: entry.text.slice(0, 16_000),
    };
  },
});

export const docsTools = app.tools({ searchFlary, openFlarySource });

function tokens(value: string): string[] {
  return [...new Set(value.toLowerCase().match(/[a-z0-9_.@/-]{2,}/g) ?? [])].slice(0, 16);
}

function score(entry: (typeof docsCorpus)[number], terms: readonly string[]): number {
  const title = entry.title.toLowerCase();
  const id = entry.id.toLowerCase();
  const text = entry.text.toLowerCase();
  return terms.reduce((total, term) => {
    if (title.includes(term)) return total + 14;
    if (id.includes(term)) return total + 9;
    const first = text.indexOf(term);
    return first < 0 ? total : total + Math.max(1, 6 - Math.floor(first / 4_000));
  }, 0);
}

function excerpt(text: string, terms: readonly string[]): string {
  const normalized = text.replace(/^---[\s\S]*?---\s*/m, "").replace(/\s+/g, " ").trim();
  const lower = normalized.toLowerCase();
  const positions = terms.map((term) => lower.indexOf(term)).filter((value) => value >= 0);
  const center = positions.length > 0 ? Math.min(...positions) : 0;
  const start = Math.max(0, center - 180);
  const end = Math.min(normalized.length, start + 700);
  return `${start > 0 ? "…" : ""}${normalized.slice(start, end)}${end < normalized.length ? "…" : ""}`;
}
