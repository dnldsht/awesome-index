import type { APIRoute } from "astro";
import { compactNumber } from "../lib/format.ts";
import { ogResponse, renderOgImage } from "../lib/og-image.ts";
import { listSummaries } from "../lib/queries.ts";

/**
 * The card every route falls back to, at the path `Base.astro` defaults to.
 * Its figures come from the same query the home page prints, so the picture and
 * the page never disagree about how big the index is.
 */

export const prerender = true;

export const GET: APIRoute = async () => {
  const summaries = await listSummaries();
  const total = summaries.reduce((sum, summary) => sum + summary.repoCount, 0);

  return ogResponse(
    await renderOgImage({
      eyebrow: "Awesome Index",
      headline: "Every awesome list tells you what exists.",
      detail: `${compactNumber(total)} projects from ${summaries.length} curated lists, each dated.`,
    }),
  );
};
