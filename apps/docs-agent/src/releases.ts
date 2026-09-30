import { z } from "zod";

const publishedPackage = z.object({
  name: z.literal("flary"),
  version: z.string().regex(/^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/),
});

export async function latestFlaryRelease(fetcher: typeof fetch = fetch) {
  const response = await fetcher("https://registry.npmjs.org/flary/latest", {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error("Could not check the current Flary release on npm.");
  const release = publishedPackage.parse(await response.json());
  return {
    version: release.version,
    tag: "latest" as const,
    url: `https://www.npmjs.com/package/flary/v/${release.version}`,
  };
}
