import type { APIRoute } from "astro";
import { categoriesForList, listSummaries } from "../lib/queries.ts";
import { categoryPath, listPath } from "../lib/urls.ts";

/**
 * Every page of this site that is not a project, as one file the header's
 * search box can hold in memory.
 *
 * The box used to be a plain GET form pointed at `/search/`, which searches
 * projects — and projects are exactly the thing github.com is better at
 * finding. What this site has that nothing else does is the shape the curators
 * gave it: 80 lists and the 3,300 headings they wrote. Those had no way in
 * other than clicking down from the front page, so they are the first thing
 * the box answers with now.
 *
 * Tuples rather than objects, because 3,400 rows of `{"title": …, "url": …}`
 * is a third again as many bytes for no more information: `[title, url,
 * context, count]`, where context is the list a category belongs to. Fetched
 * on the first focus of the box and never again, so a reader who does not
 * search never asks for it.
 */
export const GET: APIRoute = async () => {
  const summaries = await listSummaries();

  const lists = summaries.map((summary) => [
    summary.entry.name,
    listPath(summary.entry.slug),
    summary.entry.icon ?? "",
    summary.repoCount,
  ]);

  const categories: (string | number)[][] = [];
  for (const summary of summaries) {
    for (const category of await categoriesForList(summary.entry)) {
      categories.push([
        // the heading path as the category pages print it, "Web › Frameworks"
        category.path.join(" › "),
        categoryPath(summary.entry.slug, category.slug),
        summary.entry.name,
        category.count,
      ]);
    }
  }

  return new Response(JSON.stringify({ lists, categories }), {
    headers: { "content-type": "application/json" },
  });
};
