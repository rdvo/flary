import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { z } from "astro/zod";

const docs = defineCollection({
  loader: glob({
    base: new URL("../../../docs/", import.meta.url),
    pattern: "**/*.mdx",
  }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    section: z.enum(["Start", "Core", "Examples"]),
    order: z.number().int().positive(),
  }),
});

export const collections = { docs };
