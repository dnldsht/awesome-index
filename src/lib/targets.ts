/**
 * What an entry points at.
 *
 * Every row on this site used to be a GitHub repository, so "the thing an entry
 * is about" and "`<owner>/<name>`" were the same string and no abstraction was
 * needed. They are not the same thing: 12% of the entries the READMEs write
 * point somewhere else, and the awesome lists are equally happy to link a
 * project's own site, a GitLab repository or a crates.io page.
 *
 * A *target* is that thing, whoever hosts it, and a *provider* is who owns a
 * given URL. This file holds only the pure half of a provider: recognising a
 * URL and turning it into a stable id. The half that talks to the network lives
 * with the crawler (`bin/crawl.ts`, `src/lib/github.ts`, `src/lib/liveness.ts`),
 * because this module is imported by the site itself and must not drag an
 * Octokit client into the build.
 *
 * Adding gitlab.com, crates.io or npm later is one entry in `PROVIDERS` here
 * plus one refresher in the crawler. Nothing in `queries.ts`, in the routes or
 * in the search index has to learn about it: they read `kind`, `stars` and
 * `lastActivityAt` off the target and render whatever is there.
 */

/**
 * The providers that exist today. `web` is the catch-all, so it is last: it
 * claims whatever the ones before it did not.
 */
export const TARGET_KINDS = ["github", "web"] as const;

export type TargetKind = (typeof TARGET_KINDS)[number];

/**
 * A resolved link.
 *
 * `id` is identity: it is the primary key of `target`, it sits inside
 * `awesome_item`'s primary key, and it is what makes two lists linking the same
 * thing one row rather than two. It is normalised as hard as is safe.
 *
 * `url` is the link we actually show and, for `web`, the one we ping. The two
 * differ on purpose: the id of `http://www.gtkmm.org/en/` is
 * `https://gtkmm.org/en`, so a list writing it with `www` and another without
 * agree, while the outbound link stays the address the curator wrote and the
 * liveness check does not force https onto a host that only speaks http.
 *
 * For `github` the id is `<owner>/<name>` and the url is derived from it. That
 * asymmetry is deliberate, see `githubProvider`.
 */
export type ResolvedTarget = {
  kind: TargetKind;
  id: string;
  url: string;
};

type Provider = {
  kind: TargetKind;
  /**
   * Hosts this provider owns. A URL on one of them that the provider does not
   * recognise is *dropped*, never handed to `web`: github.com/sponsors/foo and
   * github.com/topics/rust are not entries, and a catch-all that swallowed them
   * would put "sponsors/foo" rows on the site.
   */
  hosts?: (host: string) => boolean;
  /** the provider's own id for this url, or undefined when it does not apply */
  match(url: URL): string | undefined;
  /** the outbound link for one of this provider's ids */
  url(id: string): string;
};

/* -------------------------------------------------------------------------- */
/* github                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * github.com paths shaped like `<owner>/<repo>` that are not repositories.
 * Awesome lists link plenty of them (github.com/sponsors/..., /topics/...).
 */
const RESERVED_OWNERS = new Set([
  "about",
  "account",
  "apps",
  "codespaces",
  "collections",
  "contact",
  "dashboard",
  "enterprise",
  "explore",
  "features",
  "issues",
  "join",
  "login",
  "marketplace",
  "new",
  "notifications",
  "organizations",
  "orgs",
  "pricing",
  "pulls",
  "search",
  "security",
  "settings",
  "site",
  "sponsors",
  "stars",
  "topics",
  "trending",
  "users",
  "watching",
]);

/**
 * "https://github.com/hyperium/hyper/tree/master#readme" -> "hyperium/hyper".
 *
 * Returns undefined for anything that is not a repository URL, which is how
 * anchors, badges pointing at shields.io and github.com/sponsors links drop out.
 */
export function normalizeRepoId(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
    return undefined;
  return githubProvider.match(parsed);
}

/**
 * The incumbent, and the one provider whose id is not a URL: a repository is
 * `hyperium/hyper`, the form 39,363 item rows and 34,808 target rows already
 * carry, the form `githubUrl()` builds a link out of, the form the search index
 * sorts by name on and the form the cards display. Prefixing it (`github:...`)
 * or spelling it out as a URL would be tidier and would touch every one of
 * those; the `kind` column says what it is without moving a single row.
 *
 * It stays unambiguous because every other provider's id is a URL and contains
 * `://`, which a repository id never does. The short form is only safe for
 * *one* provider, which is why nobody else may use it: `tozd/go/fun` could be
 * either a GitLab path or a repository, `https://gitlab.com/tozd/go/fun` can
 * only be one thing.
 */
const githubProvider: Provider = {
  kind: "github",
  hosts: (host) =>
    host === "github.com" ||
    host === "gist.github.com" ||
    host === "raw.githubusercontent.com",
  match(url) {
    if (url.hostname.replace(/^www\./, "").toLowerCase() !== "github.com") {
      return undefined;
    }
    const [owner, repo] = url.pathname.split("/").filter(Boolean);
    if (!owner || !repo) return undefined;
    if (RESERVED_OWNERS.has(owner.toLowerCase())) return undefined;

    const name = repo.replace(/\.git$/i, "").replace(/\.+$/, "");
    if (!name) return undefined;
    return `${owner}/${name}`;
  },
  url: (id) => `https://github.com/${id}`,
};

/* -------------------------------------------------------------------------- */
/* web                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Hosts that are never an entry, only decoration on one.
 *
 * Until now `normalizeRepoId` returning undefined dropped all of this for free:
 * a badge, a CI link or a donation button was simply "not a repository". The
 * catch-all below has no such luxury, so the noise has to be named. These are
 * the hosts that turn up *inside* an entry rather than as one (a build badge, a
 * coverage shield, a funding link), and a paragraph that leads with one is a
 * paragraph whose entry is somewhere else in it.
 *
 * Deliberately not here: youtube.com, twitter.com, meetup.com and the book
 * shops. Those are entries (a list with a "Podcasts" or a "People" heading
 * means them), and deciding they are the wrong *kind* of entry is the curator's
 * call, not ours.
 */
const DENIED_HOSTS = new Set([
  "shields.io",
  "img.shields.io",
  "badgen.net",
  "badge.fury.io",
  "flat.badgen.net",
  "travis-ci.org",
  "travis-ci.com",
  "circleci.com",
  "appveyor.com",
  "ci.appveyor.com",
  "codecov.io",
  "coveralls.io",
  "codeclimate.com",
  "api.codeclimate.com",
  "snyk.io",
  "sonarcloud.io",
  "deps.dev",
  "isitmaintained.com",
  "bestpractices.coreinfrastructure.org",
  "www.bestpractices.dev",
  "bestpractices.dev",
  "opencollective.com",
  "patreon.com",
  "liberapay.com",
  "ko-fi.com",
  "buymeacoffee.com",
  "paypal.com",
  "paypal.me",
  "www.paypal.me",
]);

/**
 * Query parameters that identify the reader rather than the page. Dropped from
 * the id *and* from the outbound link: they are somebody else's campaign, and
 * two lists writing the same page with different ones must not be two rows.
 */
const TRACKING_PARAMS = /^(utm_|ref$|referrer$|source$|fbclid$|gclid$|mc_)/i;

/**
 * The canonical form of a page address, as identity.
 *
 * Normalised: the scheme (always https, so http and https are one target), the
 * host (lowercased, `www.` dropped), the trailing slash, the tracking
 * parameters, and the order of whatever parameters are left.
 *
 * *Not* normalised: the port (`URL` already drops the default one, and a
 * remaining `:8080` is part of the address, not noise), the path, the surviving
 * query and the fragment. Merging
 * `boost.org` with `boost.org/libs` would be a guess, and the query and
 * fragment are load-bearing more often than they look:
 * `marketplace.visualstudio.com/items?itemName=...` is a different extension
 * per parameter and `groups.google.com/forum/#!forum/golang-nuts` is a
 * different group per fragment. Two rows for one project is a small error;
 * one row for two projects shows the wrong link, which is not.
 */
function canonicalWebUrl(url: URL): URL {
  const canonical = new URL(url.href);
  canonical.protocol = "https:";
  canonical.hostname = canonical.hostname.replace(/^www\./i, "").toLowerCase();
  canonical.username = "";
  canonical.password = "";
  canonical.pathname = canonical.pathname.replace(/\/+$/, "");

  for (const key of [...canonical.searchParams.keys()]) {
    if (TRACKING_PARAMS.test(key)) canonical.searchParams.delete(key);
  }
  canonical.searchParams.sort();

  return canonical;
}

/**
 * The outbound link: the address the curator wrote, minus the tracking, minus
 * any credentials they put in it.
 *
 * `https://admin:hunter2@host/` in a README is either a mistake or bait, and
 * either way it is not something to render into a public page for readers to
 * click, nor to hand to the reachability check to replay.
 */
function cleanedWebUrl(url: URL): string {
  const cleaned = new URL(url.href);
  cleaned.username = "";
  cleaned.password = "";
  for (const key of [...cleaned.searchParams.keys()]) {
    if (TRACKING_PARAMS.test(key)) cleaned.searchParams.delete(key);
  }
  return cleaned.href;
}

const webProvider: Provider = {
  kind: "web",
  match(url) {
    const host = url.hostname.replace(/^www\./, "").toLowerCase();
    if (!host || !host.includes(".")) return undefined;
    if (
      DENIED_HOSTS.has(host) ||
      DENIED_HOSTS.has(url.hostname.toLowerCase())
    ) {
      return undefined;
    }
    return canonicalWebUrl(url).href;
  },
  url: (id) => id,
};

/* -------------------------------------------------------------------------- */
/* the registry                                                               */
/* -------------------------------------------------------------------------- */

/**
 * In order, most specific first: the first provider that claims a URL owns it.
 * A new one (gitlab, crates, npm) goes above `web`, which claims the rest.
 */
const PROVIDERS: Provider[] = [githubProvider, webProvider];

/** the provider that owns a kind, for turning a stored id back into a link */
const byKind = new Map(PROVIDERS.map((provider) => [provider.kind, provider]));

/**
 * The target a URL points at, or undefined when it points at nothing this site
 * has a row for.
 *
 * Two ways to get undefined, and they mean different things: no provider
 * recognised the URL (a `mailto:`, a relative anchor, a bare hostname), or the
 * provider that owns the host recognised it as one of its non-entries (a
 * github.com/topics page). Both drop the link; neither falls through to the
 * catch-all.
 */
export function resolveTarget(raw: string): ResolvedTarget | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;

  const host = url.hostname.replace(/^www\./, "").toLowerCase();

  for (const provider of PROVIDERS) {
    const id = provider.match(url);
    if (id) {
      return {
        kind: provider.kind,
        id,
        url: provider.kind === "web" ? cleanedWebUrl(url) : provider.url(id),
      };
    }
    // the host is his, and he says this is not an entry
    if (provider.hosts?.(host)) return undefined;
  }

  return undefined;
}

/** the outbound link for a stored (kind, id) pair, for rows written before now */
export function targetUrl(kind: TargetKind, id: string): string {
  return byKind.get(kind)?.url(id) ?? id;
}

/** the host a `web` target lives on, as a row's second line: "gtkmm.org" */
export function targetHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}
