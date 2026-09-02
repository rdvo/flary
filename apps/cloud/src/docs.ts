import type { CollectionEntry } from "astro:content";

export type DocEntry = CollectionEntry<"docs">;

export const DOC_SECTION_ORDER = [
  "Start",
  "Build",
  "Connect",
  "Run",
  "Operate",
  "Examples",
  "Reference",
] as const;

export function docPath(id: string): string {
  return `/docs/${id}/`;
}

export function sortDocs(entries: DocEntry[]): DocEntry[] {
  return [...entries].sort((left, right) => {
    const sectionDifference =
      DOC_SECTION_ORDER.indexOf(left.data.section) - DOC_SECTION_ORDER.indexOf(right.data.section);

    return sectionDifference || left.data.order - right.data.order;
  });
}
