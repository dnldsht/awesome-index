/**
 * Talking to the two GitHub endpoints the star history is made of.
 *
 * `bin/history.ts` is the loop, the pacing and the bookkeeping; this file is
 * the part that knows what a request looks like and what its failure modes
 * mean. Both endpoints are reached with plain `fetch` rather than through
 * `src/lib/github.ts`, for two reasons that both come down to headers:
 * `If-None-Match` and the 304 it earns are the whole economics of the weekly
 * refresh, and octokit turns a 304 into a thrown error and a `NOT_FOUND` into
 * a rejected promise whose payload has to be dug out of the exception. Here a
 * 304 is a return value and a missing repository is a name in a list.
 *
 * The token convention is `src/lib/github.ts`'s, unchanged: `GITHUB_TOKEN`,
 * comma separated when several accounts are pooled, because the 5,000/hour
 * budget is per account and only adds up across different ones. `GH_TOKEN` is
 * read as a fallback so that `GITHUB_TOKEN=$(gh auth token)` is not the only
 * way to run this by hand.
 */

/* -------------------------------------------------------------------------- */
/* tokens                                                                     */
/* -------------------------------------------------------------------------- */

let tokenIndex = 0;

function tokens(): string[] {
  // read per call rather than at import: `--dry-run` and `--help` must work
  // with no token at all, and a module that throws on import cannot offer that
  const raw = process.env["GITHUB_TOKEN"] || process.env["GH_TOKEN"] || "";
  return raw
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

export function hasToken(): boolean {
  return tokens().length > 0;
}

function currentToken(): string {
  const all = tokens();
  if (all.length === 0) throw new Error("GITHUB_TOKEN is not set");
  return all[Math.min(tokenIndex, all.length - 1)]!;
}

/** moves to the next token. false means they are all spent for this window. */
function rotateToken(): boolean {
  if (tokenIndex >= tokens().length - 1) return false;
  tokenIndex++;
  return true;
}

/* -------------------------------------------------------------------------- */
/* the paced, retrying request                                                */
/* -------------------------------------------------------------------------- */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * What the last response said about the budget, for the progress line.
 *
 * Not authoritative — a 304 leaves it untouched, which is the point of a 304 —
 * but it is the only view of the quota that costs nothing to obtain.
 */
export const quota = { remaining: Number.NaN, limit: Number.NaN, resetAt: 0 };

function readQuota(headers: Headers) {
  const remaining = Number(headers.get("x-ratelimit-remaining"));
  if (!Number.isFinite(remaining)) return;
  quota.remaining = remaining;
  quota.limit = Number(headers.get("x-ratelimit-limit"));
  quota.resetAt = Number(headers.get("x-ratelimit-reset")) * 1000;
}

/**
 * One request, with the two kinds of waiting a long run has to survive.
 *
 * A 403/429 carrying `retry-after` is a *secondary* limit: it fires on burst
 * rate with budget still on the clock, and rotating tokens does not help
 * because the limit is on us. A 403/429 with `x-ratelimit-remaining: 0` is the
 * hourly budget, and there another token is worth trying before sleeping out
 * the window. Everything else gets four tries and then gives up on that page,
 * because one unreachable repository must not end a thirteen-hour backfill.
 *
 * `expect` lists the statuses the caller wants handed back rather than retried
 * or thrown — 304 and 404 are outcomes here, not errors.
 */
async function request(
  label: string,
  url: string,
  init: RequestInit & { expect?: number[] } = {},
): Promise<Response> {
  const { expect = [], ...rest } = init;

  for (let attempt = 1; ; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, {
        ...rest,
        headers: {
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "user-agent": "awesome-index",
          authorization: `Bearer ${currentToken()}`,
          ...rest.headers,
        },
      });
    } catch (error: any) {
      if (attempt >= 4) {
        console.warn(`[skip] ${label}: ${error?.message ?? error}`);
        throw error;
      }
      await sleep(attempt * 2_000);
      continue;
    }

    readQuota(response.headers);
    if (response.ok || expect.includes(response.status)) return response;

    if (response.status === 403 || response.status === 429) {
      await response.body?.cancel();

      const retryAfter = Number(response.headers.get("retry-after"));
      if (Number.isFinite(retryAfter) && retryAfter > 0) {
        console.warn(`[secondary limit] ${label}: waiting ${retryAfter}s`);
        await sleep(retryAfter * 1000 + 1_000);
        continue;
      }

      /*
       * A 403 that still reports budget left is a *secondary* limit — too many
       * requests too fast — and it clears in a minute or two, so it must not
       * fall through to the hourly-reset branch below and sleep out an hour.
       *
       * It is worth being precise about the budget this endpoint spends,
       * because the obvious measurement is misleading. `GET /rate_limit` shows
       * `core` barely touched while a backfill runs — five calls to
       * `/stargazers/history` move `used` by zero where five ordinary repo
       * calls move it by five — and it is tempting to conclude the endpoint is
       * free and pace accordingly. It is not. The 403 it eventually returns
       * carries `x-ratelimit-remaining: 0` and `x-ratelimit-resource: core`
       * while `/rate_limit` reports 4,922 of 5,000 left on that same name: the
       * endpoint draws on a budget of its own, roughly 5,000 an hour, that the
       * reporting endpoint does not expose. Running it at four in flight
       * emptied that budget in minutes and bought a 27-minute wait.
       *
       * So the honest pace is still about 1.4 requests a second, and this
       * branch only catches the genuine burst limit.
       */
      const left = Number(response.headers.get("x-ratelimit-remaining"));
      if (Number.isFinite(left) && left > 0) {
        const pause = Math.min(attempt * 30_000, 120_000);
        console.warn(
          `[secondary limit] ${label}: quota is fine (${left} left), ` +
            `waiting ${pause / 1000}s`,
        );
        await sleep(pause);
        continue;
      }

      if (rotateToken()) continue;
      const reset = Number(response.headers.get("x-ratelimit-reset"));
      const waitMs = Number.isFinite(reset)
        ? Math.max(reset * 1000 - Date.now(), 0) + 5_000
        : attempt * 60_000;
      const capped = Math.min(waitMs, 65 * 60_000);
      console.warn(
        `[rate limit] ${label}: waiting ${Math.round(capped / 1000)}s`,
      );
      await sleep(capped);
      tokenIndex = 0;
      continue;
    }

    if (response.status >= 500 && attempt < 4) {
      await response.body?.cancel();
      await sleep(attempt * 2_000);
      continue;
    }

    const body = await response.text().catch(() => "");
    if (attempt >= 4) {
      throw new Error(
        `${label}: HTTP ${response.status} ${body.slice(0, 200)}`,
      );
    }
    await sleep(attempt * 2_000);
  }
}

/* -------------------------------------------------------------------------- */
/* pass 1: the numeric ids                                                    */
/* -------------------------------------------------------------------------- */

/**
 * `databaseId` for a batch of `<owner>/<name>` ids, through GraphQL.
 *
 * A hundred aliases resolve for one rate limit point, so the whole corpus of
 * 34,808 repositories costs ~350 requests — 7% of an hour's budget for the
 * thing that makes every later request addressable by an id that survives a
 * rename. Two hundred aliases exceeds the node limit; a hundred with this
 * single field does not.
 *
 * A repository GitHub no longer serves comes back as a `null` alias with a
 * `NOT_FOUND` in `errors` *beside* the ones that resolved, so the batch is not
 * a failure and the deletion is free information. It is returned in `missing`,
 * and the caller writes it down so we stop asking.
 */
export async function fetchDatabaseIds(ids: string[]): Promise<{
  found: Map<string, number>;
  missing: string[];
}> {
  const varDefs: string[] = [];
  const selections: string[] = [];
  const variables: Record<string, string> = {};

  ids.forEach((id, i) => {
    const [owner, name] = id.split("/");
    varDefs.push(`$o${i}: String!`, `$n${i}: String!`);
    selections.push(
      `r${i}: repository(owner: $o${i}, name: $n${i}) { databaseId }`,
    );
    variables[`o${i}`] = owner!;
    variables[`n${i}`] = name!;
  });

  const query = `query ids(${varDefs.join(", ")}) {
  ${selections.join("\n  ")}
}`;

  const response = await request(
    "databaseId batch",
    "https://api.github.com/graphql",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
    },
  );
  const payload: any = await response.json();

  // a batch in which *every* alias failed is a real error (a bad token, a
  // malformed query); one where some resolved is the deleted-repository case
  const data = payload?.data;
  if (!data) {
    throw new Error(
      `databaseId batch: ${payload?.errors?.[0]?.message ?? "no data"}`,
    );
  }

  const found = new Map<string, number>();
  const missing: string[] = [];
  ids.forEach((id, i) => {
    const node = data[`r${i}`];
    if (node?.databaseId) found.set(id, node.databaseId);
    else missing.push(id);
  });
  return { found, missing };
}

/* -------------------------------------------------------------------------- */
/* pass 2: the history                                                        */
/* -------------------------------------------------------------------------- */

/** the endpoint's page size, whatever `per_page` says */
export const WEEKS_PER_PAGE = 30;

const WEEK_SECONDS = 7 * 24 * 60 * 60;

/**
 * One week as GitHub sends it. `total` is the *net gain* for that week, not a
 * running total — it is the sum of `days`, and it is what `star_history.delta`
 * stores. The cumulative curve is reconstructed from `target.stars` backwards
 * when something needs it, which is why nothing here keeps one.
 */
export type HistoryWeek = { week: number; total: number; days: number[] };

export type HistoryPage =
  | {
      kind: "ok";
      weeks: HistoryWeek[];
      etag: string | null;
      /**
       * The last page that holds anything, from the `Link` header. Null when
       * the header is absent, which means this page is the only one.
       */
      lastPage: number | null;
    }
  /** the ETag matched: the page is unchanged, and this cost no quota */
  | { kind: "notModified" }
  /** 404 or 451 — deleted, made private, or taken down. Stop asking. */
  | { kind: "gone" };

function linkLastPage(link: string | null): number | null {
  if (!link) return null;
  const match = link.match(/[?&]page=(\d+)[^>]*>;\s*rel="last"/);
  return match ? Number(match[1]) : null;
}

/**
 * One page of `GET /repositories/{id}/stargazers/history`.
 *
 * Addressed by numeric id rather than by `<owner>/<name>`: a rename otherwise
 * silently splits a repository's history in two, because the old name keeps
 * answering through GitHub's redirect while the new one starts a fresh series.
 *
 * Pages count backwards from the present, 30 weeks each, so page 1 is the only
 * one that can ever change and the only one worth an `If-None-Match`. A 304
 * costs no quota at all, which is the entire reason the weekly refresh over
 * 35,000 repositories is affordable.
 */
export async function fetchHistoryPage(
  databaseId: number,
  page: number,
  etag?: string | null,
): Promise<HistoryPage> {
  const url = `https://api.github.com/repositories/${databaseId}/stargazers/history?page=${page}`;
  const response = await request(`repo ${databaseId} page ${page}`, url, {
    headers: etag ? { "if-none-match": etag } : {},
    expect: [304, 404, 451],
  });

  if (response.status === 304) {
    await response.body?.cancel();
    return { kind: "notModified" };
  }
  if (response.status === 404 || response.status === 451) {
    await response.body?.cancel();
    return { kind: "gone" };
  }

  const weeks = (await response.json()) as HistoryWeek[];
  return {
    kind: "ok",
    weeks: Array.isArray(weeks) ? weeks : [],
    etag: response.headers.get("etag"),
    lastPage: linkLastPage(response.headers.get("link")),
  };
}

/**
 * How many pages a repository of this age can possibly have.
 *
 * The history begins at the repository's creation, so its length is known
 * before a single request is sent — which is what makes `--dry-run` an exact
 * projection rather than a guess, and what stops a `--pages=6` run from
 * spending five requests discovering that a repository is four months old.
 * Cost here is driven by age, never by star count: a repository with 144,000
 * stars and one with nine cost the same if they were created the same week.
 *
 * Null `createdAt` means the metadata pass has never seen the row, and then
 * the requested depth is the only honest answer.
 */
export function plannedPages(
  createdAt: Date | null,
  depth: number,
  now = new Date(),
): number {
  if (!createdAt) return depth;
  const weeks = (now.getTime() - createdAt.getTime()) / 1000 / WEEK_SECONDS;
  const pages = Math.ceil(weeks / WEEKS_PER_PAGE);
  return Math.min(depth, Math.max(1, pages));
}
