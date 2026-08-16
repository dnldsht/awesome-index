import { z } from "astro/zod";
import * as fs from "node:fs/promises";
import YAML from "yaml";
import { slugify } from "./slug.ts";

export const GITHUB_PREFIX = "https://github.com/";

const ConfigSchema = z.object({
  repos: z.array(
    z.object({
      name: z.string(),
      /** one list, or several merged into a single page */
      url: z
        .union([z.string(), z.array(z.string())])
        .transform((u) => (Array.isArray(u) ? u : [u])),
      icon: z.string().optional(),
      /** other entries to surface first in the "more lists" rail */
      related: z.array(z.string()).default([]),
    }),
  ),
});

export type ConfigEntry = ReturnType<typeof toEntry>;

function toEntry(raw: z.infer<typeof ConfigSchema>["repos"][number]) {
  return {
    ...raw,
    slug: slugify(raw.name),
    /** "<owner>/<repo>" for every source list behind this entry */
    sourceIds: raw.url.map((url) => {
      if (!url.startsWith(GITHUB_PREFIX)) {
        throw new Error(`config.yaml: ${raw.name} has a non-github url ${url}`);
      }
      return url.slice(GITHUB_PREFIX.length).replace(/\/+$/, "");
    }),
  };
}

let cached: ConfigEntry[] | undefined;

export async function loadConfig(): Promise<ConfigEntry[]> {
  if (cached) return cached;
  const parsed = ConfigSchema.parse(
    YAML.parse(await fs.readFile("config.yaml", "utf8")),
  );
  const entries = parsed.repos.map(toEntry);

  const bySlug = new Set<string>();
  for (const entry of entries) {
    if (bySlug.has(entry.slug)) {
      throw new Error(`config.yaml: duplicate slug "${entry.slug}"`);
    }
    bySlug.add(entry.slug);
  }

  cached = entries;
  return entries;
}

export async function findEntry(slug: string) {
  return (await loadConfig()).find((x) => x.slug === slug);
}
