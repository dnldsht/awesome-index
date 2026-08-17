import type { APIRoute } from "astro";
import { luckyPaths } from "../lib/lucky.ts";

/**
 * The pool the home page's "I'm feeling lucky" draws from.
 *
 * A separate file rather than an array inlined into the page: the home page is
 * the one URL every reader loads and almost none of them press the button, so
 * 30KB of paths in the document would be paid by everyone. It is fetched on
 * hover, and the anchor's build-time href stands in whenever the fetch has not
 * landed, has failed, or never ran.
 */
export const GET: APIRoute = async () => {
  return new Response(JSON.stringify(await luckyPaths()), {
    headers: { "content-type": "application/json" },
  });
};
