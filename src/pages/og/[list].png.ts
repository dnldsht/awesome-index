import type { APIRoute } from "astro";
import { compactNumber, relativeTime } from "../../lib/format.ts";
import { ogResponse, pulseFor, renderOgImage } from "../../lib/og-image.ts";
import { listSummaries } from "../../lib/queries.ts";

/**
 * One card per crawled list, at `/og/<slug>.png` — the path `ogListPath()`
 * returns. Built off `listSummaries()`, the same gate the list pages use, so
 * there is never a card for a list with no page or a page with no card.
 *
 * The static `og/` segment means this cannot collide with `/[list]/`: in a
 * static build both routes only emit the paths their `getStaticPaths` returns,
 * and no list slug is "og".
 */

export const prerender = true;

export async function getStaticPaths() {
  const summaries = await listSummaries();
  return summaries.map((summary) => ({
    params: { list: summary.entry.slug },
  }));
}

export const GET: APIRoute = async ({ params }) => {
  const summaries = await listSummaries();
  const summary = summaries.find((s) => s.entry.slug === params.list);
  if (!summary) return new Response("not found", { status: 404 });

  const detail = [
    `${compactNumber(summary.repoCount)} projects`,
    summary.lastActivity &&
      `newest change ${relativeTime(summary.lastActivity)}`,
  ]
    .filter(Boolean)
    .join("  ·  ");

  return ogResponse(
    await renderOgImage({
      // the config icon is an emoji and satori would need a colour emoji font
      // to draw one, so the card carries the name alone
      eyebrow: "Awesome Index",
      headline: `Awesome ${summary.entry.name}`,
      detail,
      pulse: pulseFor(summary.lastActivity),
    }),
  );
};
