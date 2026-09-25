/**
 * Gives a rank to the rows that have no stars of their own.
 *
 * 11,491 of the 46,299 targets are not repositories, and until this pass ran
 * none of them could be ordered against anything: `target.stars` was null and
 * the listings put them after the ranking, in the curator's order, because a
 * website has no star count and inventing one is worse than admitting it. That
 * remains true of the column. What this pass establishes is the *other* thing a
 * listing needs, which is where the row belongs, from evidence somebody else
 * already collected.
 *
 * Three passes, cheapest first:
 *
 * 1. inherited: offline, no network at all. A link's host is matched against
 *    the "Website" field of the repositories we already hold, so `react.dev`
 *    finds `facebook/react` and takes its stars. 722 rows, and the only pass
 *    whose input is entirely local.
 * 2. registries: a package page is asked which repository it was built from
 *    (`crates.io/crates/serde` -> `serde-rs/serde`), and told its own download
 *    or favourite count when it has no repository to give. ~670 rows.
 * 3. forges: GitLab, Codeberg, Gitea and Gitee are asked for their own star
 *    counts, which are stars but not on GitHub's scale. ~230 rows.
 *
 * Only pass 1 and the repository half of pass 2 end up holding a real GitHub
 * star count. Everything else is calibrated against the star distribution of the
 * repositories in this dataset before it is allowed into the order. See
 * src/lib/popularity.ts, which explains why that is defensible and why the
 * calibrated number is never shown to a reader.
 *
 * Hand corrections live in popularity.yaml, because the one thing this cannot
 * infer is whether a domain and a repository are the same project.
 *
 * Usage: pnpm popularity [--dry-run] [--report] [--skip-registries]
 */
import * as D from "drizzle-orm";
import * as fs from "node:fs/promises";
import { parseArgs } from "node:util";
import PQueue from "p-queue";
import YAML from "yaml";
import { z } from "zod";
import { db } from "../src/lib/db/client.ts";
import { targetTable } from "../src/lib/db/schema.ts";
import { fetchGithubProjects } from "../src/lib/github.ts";
import {
  GITHUB_COHORT,
  repoUrlFromManifest,
  starEquivalents,
  type Measurement,
  type PopularitySource,
} from "../src/lib/popularity.ts";
import { normalizeRepoId, targetHost } from "../src/lib/targets.ts";

const { values: flags } = parseArgs({
  options: {
    "skip-inherited": { type: "boolean", default: false },
    "skip-registries": { type: "boolean", default: false },
    "skip-forges": { type: "boolean", default: false },
    report: { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});

if (flags.help) {
  console.log(`pnpm popularity [options]

  --skip-inherited    do not match link hosts against repository homepages
  --skip-registries   do not ask package registries (the only slow pass)
  --skip-forges       do not ask GitLab, Codeberg, Gitea, Gitee
  --report            print the matches held back by minInheritedStars, so the
                      tail can be reviewed and popularity.yaml extended
  --dry-run           resolve everything but write nothing

A skipped pass leaves the rows it owns exactly as they were; the passes that do
run replace theirs wholesale, so a link that stops resolving loses its rank
rather than keeping a stale one.
`);
  process.exit(0);
}

const DRY_RUN = flags["dry-run"];

/** sqlite caps bound parameters per statement, so wide writes have to chunk */
const INSERT_CHUNK = 400;

/** breathing room between two requests to the *same* host */
const HOST_GAP_MS = 250;

/** how many hosts are talked to at once; each host is a queue of one */
const HOST_CONCURRENCY = 8;

/* -- popularity.yaml ------------------------------------------------------- */

const OverridesSchema = z.object({
  sharedHosts: z.array(z.string()).default([]),
  rejected: z
    .array(z.object({ host: z.string(), repo: z.string(), why: z.string() }))
    .default([]),
  minInheritedStars: z.number().default(0),
});

type Overrides = {
  sharedHosts: Set<string>;
  /** "<host>\0<lowercased repo id>" for every pair a person has rejected */
  rejected: Set<string>;
  minInheritedStars: number;
};

const rejectionKey = (host: string, repo: string) =>
  `${host.toLowerCase()}\0${repo.toLowerCase()}`;

async function loadOverrides(): Promise<Overrides> {
  const parsed = OverridesSchema.parse(
    YAML.parse(await fs.readFile("popularity.yaml", "utf8")),
  );
  return {
    sharedHosts: new Set(parsed.sharedHosts.map((h) => h.toLowerCase())),
    rejected: new Set(parsed.rejected.map((r) => rejectionKey(r.host, r.repo))),
    minInheritedStars: parsed.minInheritedStars,
  };
}

/* -- http ------------------------------------------------------------------ */

const queues = new Map<string, PQueue>();

/**
 * A GET whose only promise is that no third party sees two of our requests at
 * once.
 *
 * Every host gets a queue of one with a gap between jobs, which is the same
 * arrangement the link check in crawl.ts uses and for the same reason: these are
 * a dozen small public APIs run by volunteers, and the polite shape of ~700
 * requests is a thin steady trickle per host rather than a burst.
 *
 * Failure is a return value. A registry that 404s a package, rate limits us or
 * simply times out means "no figure for this row", which is a state the dataset
 * already knows how to hold; throwing would abandon the other 700.
 */
async function getJson(url: string): Promise<unknown | undefined> {
  const host = targetHost(url) || url;
  let queue = queues.get(host);
  if (!queue) {
    queue = new PQueue({
      concurrency: 1,
      interval: HOST_GAP_MS,
      intervalCap: 1,
    });
    queues.set(host, queue);
  }

  return queue.add(async () => {
    try {
      const response = await fetch(url, {
        headers: {
          accept: "application/json",
          // several of these APIs ask for a contactable agent, and the ones that
          // do not still deserve to know who is calling
          "user-agent":
            "awesome-index (+https://github.com/dnldsht/awesome-index)",
        },
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) return undefined;
      return await response.json();
    } catch {
      return undefined;
    }
  }) as Promise<unknown | undefined>;
}

/** reads a path out of parsed json without pretending to know its shape */
function pick(value: unknown, ...path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

/* -- what we are resolving ------------------------------------------------- */

type WebTarget = { id: string; url: string; host: string; path: string };

async function webTargets(): Promise<WebTarget[]> {
  const rows = await db
    .select({ id: targetTable.id, url: targetTable.url })
    .from(targetTable)
    .where(D.ne(targetTable.kind, "github"));

  return rows.map((row) => {
    let path = "";
    try {
      path = new URL(row.url).pathname.replace(/^\/+|\/+$/g, "");
    } catch {
      path = "";
    }
    return { id: row.id, url: row.url, host: targetHost(row.url), path };
  });
}

/**
 * A candidate repository for a row, before its stars are known.
 *
 * Kept separate from `Measurement` because the two passes that produce these
 * find a repository id and nothing else: the stars are filled in afterwards,
 * from the dataset where we already hold them and from one batched GraphQL call
 * where we do not.
 */
type RepoCandidate = {
  targetId: string;
  source: Extract<PopularitySource, "inherited" | "registryRepo">;
  repoId: string;
  /** what the match went through, for the log and for popularity.yaml */
  via: string;
};

/* -- pass 1: inherited ----------------------------------------------------- */

/**
 * Link hosts matched against the "Website" of the repositories we hold.
 *
 * Three things narrow a raw host match down to something worth trusting, and all
 * three were measured rather than guessed:
 *
 * - **Only the bare domain.** A match on `angular.dev` is the project; a match
 *   on `angular.dev/llms.txt` is a page *of* the project, and handing it
 *   angular/angular's 100,995 stars states something false about that page. 487
 *   rows match this way and every one of them is dropped.
 * - **Only single-claimant domains.** 854 hosts are named by two or more
 *   repositories (npmjs.com by 250 of them), and there the host says nothing
 *   about which repository a link means.
 * - **Only above `minInheritedStars`.** Below it the error rate goes from ~2% to
 *   an estimated 35-40%, for 0.2% of the stars. See popularity.yaml.
 *
 * `<owner>.github.io[/<repo>]` is resolved by construction instead of by
 * homepage, since GitHub Pages addresses say which repository they are published
 * from. Sub-subdomains are excluded: `docs.foo.github.io` is not a repository
 * address.
 */
async function inheritedCandidates(
  targets: WebTarget[],
  overrides: Overrides,
): Promise<{ candidates: RepoCandidate[]; heldBack: RepoCandidate[] }> {
  const repos = await db
    .select({
      id: targetTable.id,
      stars: targetTable.stars,
      homepageUrl: targetTable.homepageUrl,
    })
    .from(targetTable)
    .where(D.eq(targetTable.kind, "github"));

  const byLowerId = new Map(repos.map((r) => [r.id.toLowerCase(), r.id]));
  const starsOf = new Map(repos.map((r) => [r.id, r.stars ?? 0]));

  // host -> the repositories claiming it; a host with more than one is unusable
  const claimants = new Map<string, string[]>();
  for (const repo of repos) {
    const host = repo.homepageUrl ? targetHost(repo.homepageUrl) : "";
    if (host === "") continue;
    const claiming = claimants.get(host) ?? [];
    claiming.push(repo.id);
    claimants.set(host, claiming);
  }

  const candidates: RepoCandidate[] = [];
  const heldBack: RepoCandidate[] = [];
  let sharedHost = 0;
  let innerPage = 0;
  let rejected = 0;

  for (const target of targets) {
    let match: RepoCandidate | undefined;

    // github.io first: it is derived, not matched, so it beats a homepage hit
    const pages = /^([^.]+)\.github\.io$/.exec(target.host);
    if (pages) {
      const owner = pages[1]!;
      const repo = target.path.split("/")[0] || target.host;
      const id = byLowerId.get(`${owner}/${repo}`.toLowerCase());
      if (id)
        match = {
          targetId: target.id,
          source: "inherited",
          repoId: id,
          via: target.host,
        };
    }

    if (!match) {
      if (overrides.sharedHosts.has(target.host)) continue;
      const claiming = claimants.get(target.host);
      if (!claiming) continue;
      if (claiming.length > 1) {
        sharedHost++;
        continue;
      }
      if (target.path !== "") {
        innerPage++;
        continue;
      }
      match = {
        targetId: target.id,
        source: "inherited",
        repoId: claiming[0]!,
        via: target.host,
      };
    }

    if (overrides.rejected.has(rejectionKey(match.via, match.repoId))) {
      rejected++;
      continue;
    }
    if ((starsOf.get(match.repoId) ?? 0) < overrides.minInheritedStars) {
      heldBack.push(match);
      continue;
    }
    candidates.push(match);
  }

  console.log(
    `[inherited] ${candidates.length} matched · ${heldBack.length} under ` +
      `${overrides.minInheritedStars} stars · ${innerPage} inner pages · ` +
      `${sharedHost} shared hosts · ${rejected} rejected by hand`,
  );
  return { candidates, heldBack };
}

/* -- pass 2: registries ---------------------------------------------------- */

/**
 * One package registry, as far as this pass cares: which links belong to it,
 * how to get a package name out of one, and what to ask.
 *
 * `repo` returns the repository the package declares, `native` the registry's own
 * figure. A registry that answers `repo` still has its `native` read, because the
 * repository can turn out to be somewhere we cannot count stars (~20 Perl
 * distributions live on GitLab or sr.ht), and then the native figure is all the
 * row has.
 */
type Registry = {
  name: string;
  hosts: string[];
  /** undefined when the url is not a package page: a search, a category, a pdf */
  pkg: (target: WebTarget) => string | undefined;
  resolve: (pkg: string) => Promise<{
    repoUrl?: string | undefined;
    native?: { metric: string; value: number } | undefined;
  }>;
};

/** "github.com/gin-gonic/gin/v2" -> "gin-gonic/gin", for the Go doc hosts */
function goModuleRepo(path: string): string | undefined {
  const parts = path.split("/").filter(Boolean);
  if (parts[0] !== "github.com" || parts.length < 3) return undefined;
  return `https://github.com/${parts[1]}/${parts[2]}`;
}

const REGISTRIES: Registry[] = [
  {
    name: "crates.io",
    hosts: ["crates.io", "docs.rs"],
    pkg: (t) => {
      const parts = t.path.split("/").filter(Boolean);
      if (t.host === "docs.rs") return parts[0];
      return parts[0] === "crates" ? parts[1] : undefined;
    },
    resolve: async (pkg) => {
      const json = await getJson(`https://crates.io/api/v1/crates/${pkg}`);
      const crate = pick(json, "crate");
      const downloads = asNumber(pick(crate, "recent_downloads"));
      return {
        repoUrl:
          typeof pick(crate, "repository") === "string"
            ? (pick(crate, "repository") as string)
            : undefined,
        native:
          downloads === undefined
            ? undefined
            : { metric: "recentDownloads", value: downloads },
      };
    },
  },
  {
    name: "metacpan",
    hosts: ["metacpan.org"],
    pkg: (t) => {
      const parts = t.path.split("/").filter(Boolean);
      if (parts[0] === "search") return undefined;
      // /pod/Mojolicious, /release/Mojolicious, /dist/Mojolicious,
      // /pod/distribution/Mojo-DOM/lib/..., and the bare legacy /Mojolicious
      if (parts[0] === "pod" && parts[1] === "distribution") return parts[2];
      if (parts[0] === "pod" && parts[1] === "release")
        return parts[3]?.replace(/-[\d.]+$/, "");
      if (["pod", "release", "dist", "module"].includes(parts[0] ?? ""))
        return parts[1];
      return parts.length === 1 ? parts[0] : undefined;
    },
    resolve: async (pkg) => {
      // the module endpoint names the distribution and carries the "++" tally;
      // the repository only exists on the release, so both are needed
      const module = await getJson(
        `https://fastapi.metacpan.org/v1/module/${encodeURIComponent(pkg)}`,
      );
      const dist = pick(module, "distribution");
      const distribution =
        typeof dist === "string" ? dist : pkg.replace(/::/g, "-");
      // null here means zero rather than absent, which is worth keeping: 42 of
      // 297 distributions have nobody's "++" and they belong at the bottom
      const favourites = asNumber(pick(module, "dist_fav_count")) ?? 0;

      const release = await getJson(
        `https://fastapi.metacpan.org/v1/release/${encodeURIComponent(distribution)}`,
      );
      const resources = pick(release, "resources");
      const web = pick(resources, "repository", "web");
      // 59 of the 225 hits declare only the git remote, in git:// form
      const remote = pick(resources, "repository", "url");
      const declared =
        typeof web === "string"
          ? web
          : typeof remote === "string"
            ? remote
            : undefined;

      return {
        repoUrl: declared ? repoUrlFromManifest(declared) : undefined,
        native: { metric: "favourites", value: favourites },
      };
    },
  },
  {
    name: "cran",
    hosts: ["cran.r-project.org", "cran.rstudio.com"],
    pkg: (t) => {
      const packages = /(?:^|\/)web\/packages\/([^/]+)/.exec(t.path);
      if (packages) return packages[1];
      // cran.r-project.org/package=dplyr
      const query = /package=([^&]+)/.exec(t.url);
      return query?.[1];
    },
    resolve: async (pkg) => {
      const meta = await getJson(`https://crandb.r-pkg.org/${pkg}`);
      // URL is a comma separated list and only sometimes holds the repository;
      // BugReports is the issue tracker, which names it just as reliably
      const fields = [pick(meta, "URL"), pick(meta, "BugReports")]
        .filter((f): f is string => typeof f === "string")
        .flatMap((f) => f.split(","));
      const repoUrl = fields
        .map((f) => repoUrlFromManifest(f))
        .find((f) => f !== undefined && normalizeRepoId(f) !== undefined);

      const logs = await getJson(
        `https://cranlogs.r-pkg.org/downloads/total/last-month/${pkg}`,
      );
      const downloads = Array.isArray(logs)
        ? asNumber(pick(logs[0], "downloads"))
        : undefined;

      return {
        repoUrl,
        native:
          downloads === undefined
            ? undefined
            : { metric: "monthlyDownloads", value: downloads },
      };
    },
  },
  {
    name: "npm",
    hosts: ["npmjs.com", "npmjs.org"],
    pkg: (t) => {
      const parts = t.path.split("/").filter(Boolean);
      if (parts[0] !== "package") return undefined;
      // scoped packages keep their slash: /package/@scope/name
      return parts[1]?.startsWith("@") ? `${parts[1]}/${parts[2]}` : parts[1];
    },
    resolve: async (pkg) => {
      const meta = await getJson(`https://registry.npmjs.org/${pkg}`);
      const declared = pick(meta, "repository", "url");
      const point = await getJson(
        `https://api.npmjs.org/downloads/point/last-month/${pkg}`,
      );
      const downloads = asNumber(pick(point, "downloads"));
      return {
        repoUrl:
          typeof declared === "string"
            ? repoUrlFromManifest(declared)
            : undefined,
        native:
          downloads === undefined
            ? undefined
            : { metric: "monthlyDownloads", value: downloads },
      };
    },
  },
  {
    name: "pypi",
    hosts: ["pypi.org", "pypi.python.org"],
    pkg: (t) => {
      const parts = t.path.split("/").filter(Boolean);
      return parts[0] === "project" || parts[0] === "pypi"
        ? parts[1]
        : undefined;
    },
    resolve: async (pkg) => {
      const meta = await getJson(`https://pypi.org/pypi/${pkg}/json`);
      const urls = pick(meta, "info", "project_urls");
      const candidates = [
        ...(typeof urls === "object" && urls !== null
          ? Object.values(urls as Record<string, unknown>)
          : []),
        pick(meta, "info", "home_page"),
      ].filter((v): v is string => typeof v === "string");
      const repoUrl = candidates
        .map((c) => repoUrlFromManifest(c))
        .find((c) => c !== undefined && normalizeRepoId(c) !== undefined);
      // PyPI serves no download counts of its own; the repository is all there is
      return { repoUrl };
    },
  },
  {
    name: "hex",
    hosts: ["hex.pm", "hexdocs.pm"],
    pkg: (t) => {
      const parts = t.path.split("/").filter(Boolean);
      // hexdocs.pm/<pkg>/... is the docs host for the same package name
      return t.host === "hexdocs.pm"
        ? parts[0]
        : parts[0] === "packages"
          ? parts[1]
          : undefined;
    },
    resolve: async (pkg) => {
      const meta = await getJson(`https://hex.pm/api/packages/${pkg}`);
      const links = pick(meta, "meta", "links");
      const candidates =
        typeof links === "object" && links !== null
          ? Object.values(links as Record<string, unknown>).filter(
              (v): v is string => typeof v === "string",
            )
          : [];
      const repoUrl = candidates
        .map((c) => repoUrlFromManifest(c))
        .find((c) => c !== undefined && normalizeRepoId(c) !== undefined);
      const downloads = asNumber(pick(meta, "downloads", "recent"));
      return {
        repoUrl,
        native:
          downloads === undefined
            ? undefined
            : { metric: "recentDownloads", value: downloads },
      };
    },
  },
  {
    name: "huggingface",
    hosts: ["huggingface.co"],
    pkg: (t) => {
      const parts = t.path.split("/").filter(Boolean);
      if (parts.length < 2) return undefined;
      // models live at the root, datasets and spaces under a prefix
      const kind =
        parts[0] === "datasets" || parts[0] === "spaces" ? parts[0] : "models";
      const owner = kind === "models" ? parts[0] : parts[1];
      const name = kind === "models" ? parts[1] : parts[2];
      return name ? `${kind}:${owner}/${name}` : undefined;
    },
    resolve: async (pkg) => {
      const [kind, id] = pkg.split(":") as [string, string];
      const endpoint = kind === "models" ? "models" : kind;
      const meta = await getJson(
        `https://huggingface.co/api/${endpoint}/${id}`,
      );
      const likes = asNumber(pick(meta, "likes"));
      // likes rather than downloads: a model pulled by CI a million times is not
      // more wanted than one a thousand people bookmarked, and downloads on this
      // host are dominated by automation
      return {
        native:
          likes === undefined ? undefined : { metric: "likes", value: likes },
      };
    },
  },
  {
    name: "go",
    hosts: ["pkg.go.dev", "godoc.org"],
    // a Go module path *is* its repository address, so this one needs no request
    pkg: (t) => goModuleRepo(t.path),
    resolve: async (repoUrl) => ({ repoUrl }),
  },
];

const REGISTRY_BY_HOST = new Map(
  REGISTRIES.flatMap((registry) =>
    registry.hosts.map((host) => [host, registry]),
  ),
);

async function registryMeasurements(
  targets: WebTarget[],
): Promise<{ candidates: RepoCandidate[]; native: Measurement[] }> {
  const work: { target: WebTarget; registry: Registry; pkg: string }[] = [];
  let notPackages = 0;

  for (const target of targets) {
    const registry = REGISTRY_BY_HOST.get(target.host);
    if (!registry) continue;
    const pkg = registry.pkg(target);
    if (!pkg) {
      notPackages++;
      continue;
    }
    work.push({ target, registry, pkg });
  }

  console.log(
    `[registries] ${work.length} package pages across ${REGISTRIES.length} ` +
      `registries · ${notPackages} urls that are not packages`,
  );

  const candidates: RepoCandidate[] = [];
  const native: Measurement[] = [];
  const queue = new PQueue({ concurrency: HOST_CONCURRENCY });
  let done = 0;

  await queue.addAll(
    work.map(({ target, registry, pkg }) => async () => {
      const result = await registry.resolve(pkg);
      const repoId = result.repoUrl
        ? normalizeRepoId(result.repoUrl)
        : undefined;

      if (repoId) {
        candidates.push({
          targetId: target.id,
          source: "registryRepo",
          repoId,
          via: `${registry.name}/${pkg}`,
        });
      } else if (result.native) {
        native.push({
          targetId: target.id,
          source: "registryNative",
          ref: `${registry.name}/${pkg}`,
          raw: result.native.value,
          cohort: `${registry.name}:${result.native.metric}`,
        });
      }

      if (++done % 100 === 0)
        console.log(`[registries] ${done}/${work.length}`);
    }),
  );

  console.log(
    `[registries] ${candidates.length} resolved to a repository · ` +
      `${native.length} to a figure of their own · ` +
      `${work.length - candidates.length - native.length} to nothing`,
  );
  return { candidates, native };
}

/* -- pass 3: forges -------------------------------------------------------- */

/**
 * The forges that publish a star count, and how to ask.
 *
 * SourceForge, sr.ht, Savannah and Pagure are deliberately absent: 49 rows point
 * at them and none of the four exposes any measure of appreciation at all. That
 * is not a gap in this pass, it is a fact about those hosts, and the rows stay
 * unranked. SourceForge does publish weekly downloads, which is traffic rather
 * than appreciation and so cannot be calibrated against stars.
 */
type Forge = {
  /** the cohort these stars are ranked inside; small instances share one */
  cohort: string;
  api: (host: string, path: string) => string | undefined;
  stars: (json: unknown) => number | undefined;
};

const gitlabForge = (cohort: string): Forge => ({
  cohort,
  api: (host, path) => {
    // a subgroup path is part of the project id, url-encoded whole
    const parts = path.split("/").filter(Boolean);
    const cut = parts.indexOf("-");
    const project = (cut === -1 ? parts : parts.slice(0, cut)).join("/");
    return project.includes("/")
      ? `https://${host}/api/v4/projects/${encodeURIComponent(project)}`
      : undefined;
  },
  stars: (json) => asNumber(pick(json, "star_count")),
});

const forgejoForge = (cohort: string): Forge => ({
  cohort,
  api: (host, path) => {
    const parts = path.split("/").filter(Boolean);
    return parts.length >= 2
      ? `https://${host}/api/v1/repos/${parts[0]}/${parts[1]}`
      : undefined;
  },
  stars: (json) => asNumber(pick(json, "stars_count")),
});

/** every instance too small to have a distribution of its own, pooled */
const OTHER_FORGE = "forge:other";

const FORGES = new Map<string, Forge>([
  ["gitlab.com", gitlabForge("gitlab.com")],
  ["codeberg.org", forgejoForge("codeberg.org")],
  ["framagit.org", gitlabForge(OTHER_FORGE)],
  ["gitlab.freedesktop.org", gitlabForge(OTHER_FORGE)],
  ["gitlab.redox-os.org", gitlabForge(OTHER_FORGE)],
  ["gitlab.torproject.org", gitlabForge(OTHER_FORGE)],
  ["invent.kde.org", gitlabForge(OTHER_FORGE)],
  ["gitea.com", forgejoForge(OTHER_FORGE)],
  [
    "gitee.com",
    {
      cohort: OTHER_FORGE,
      api: (host, path) => {
        const parts = path.split("/").filter(Boolean);
        return parts.length >= 2
          ? `https://${host}/api/v5/repos/${parts[0]}/${parts[1]}`
          : undefined;
      },
      stars: (json) => asNumber(pick(json, "stargazers_count")),
    },
  ],
]);

async function forgeMeasurements(targets: WebTarget[]): Promise<Measurement[]> {
  const work: { target: WebTarget; forge: Forge; api: string }[] = [];
  let notRepos = 0;

  for (const target of targets) {
    const forge = FORGES.get(target.host);
    if (!forge) continue;
    const api = forge.api(target.host, target.path);
    if (!api) {
      notRepos++;
      continue;
    }
    work.push({ target, forge, api });
  }

  console.log(
    `[forges] ${work.length} repositories · ${notRepos} urls that are not one`,
  );

  const measurements: Measurement[] = [];
  const queue = new PQueue({ concurrency: HOST_CONCURRENCY });

  await queue.addAll(
    work.map(({ target, forge, api }) => async () => {
      const stars = forge.stars(await getJson(api));
      if (stars === undefined) return;
      measurements.push({
        targetId: target.id,
        source: "forge",
        ref: `${target.host}/${target.path}`,
        raw: stars,
        cohort: forge.cohort,
      });
    }),
  );

  console.log(`[forges] ${measurements.length} answered with a star count`);
  return measurements;
}

/* -- stars for the candidates --------------------------------------------- */

/**
 * Turns repository ids into measurements by finding their stars.
 *
 * Most are already here (a project's site and its repository are often both
 * linked, by the same list or by another), and the rest go through one batched
 * GraphQL call each 100 rather than a request apiece. A repository that has
 * since been deleted or renamed away resolves to nothing and its row stays
 * unranked, which is the honest outcome: we matched a link to something that is
 * no longer there.
 */
async function starsForCandidates(
  candidates: RepoCandidate[],
): Promise<Measurement[]> {
  const wanted = [...new Set(candidates.map((c) => c.repoId))];
  if (wanted.length === 0) return [];

  const held = await db
    .select({ id: targetTable.id, stars: targetTable.stars })
    .from(targetTable)
    .where(
      D.and(
        D.eq(targetTable.kind, "github"),
        D.inArray(targetTable.id, wanted),
      ),
    );

  const stars = new Map<string, number>();
  for (const row of held) if (row.stars !== null) stars.set(row.id, row.stars);

  const missing = wanted.filter((id) => !stars.has(id));
  console.log(
    `[stars] ${stars.size} already in the dataset · ${missing.length} to fetch`,
  );

  if (missing.length > 0 && process.env["GITHUB_TOKEN"]) {
    for (let i = 0; i < missing.length; i += 100) {
      const batch = missing.slice(i, i + 100);
      try {
        const { projects } = await fetchGithubProjects(batch);
        for (const project of projects.values())
          stars.set(project.id, project.stars);
      } catch (error: any) {
        console.warn(`[stars] batch failed: ${error?.message ?? error}`);
      }
    }
  } else if (missing.length > 0) {
    console.warn(
      `[stars] GITHUB_TOKEN is not set, so ${missing.length} matched ` +
        `repositories stay unranked; re-run with a token to include them`,
    );
  }

  const measurements: Measurement[] = [];
  let dead = 0;
  for (const candidate of candidates) {
    const count = stars.get(candidate.repoId);
    if (count === undefined) {
      dead++;
      continue;
    }
    measurements.push({
      targetId: candidate.targetId,
      source: candidate.source,
      ref: candidate.repoId,
      raw: count,
      cohort: GITHUB_COHORT,
    });
  }
  if (dead > 0)
    console.log(`[stars] ${dead} matched a repository we cannot count`);
  return measurements;
}

/* -- writing -------------------------------------------------------------- */

async function persist(
  measurements: Measurement[],
  popularity: Map<string, number>,
  ranSources: PopularitySource[],
) {
  if (DRY_RUN) {
    console.log(`[write] dry run, ${popularity.size} rows left untouched`);
    return;
  }

  // the passes that ran own their rows outright: clearing first is what lets a
  // link that stopped resolving lose its rank instead of keeping a stale one
  await db
    .update(targetTable)
    .set({
      popularity: null,
      popularitySource: null,
      popularityRef: null,
      popularityRaw: null,
      popularityCohort: null,
    })
    .where(D.inArray(targetTable.popularitySource, ranSources));

  const writable = measurements.filter((m) => popularity.has(m.targetId));
  for (let i = 0; i < writable.length; i += INSERT_CHUNK) {
    const chunk = writable.slice(i, i + INSERT_CHUNK);
    db.transaction((tx) => {
      for (const measurement of chunk) {
        tx.update(targetTable)
          .set({
            popularity: popularity.get(measurement.targetId)!,
            popularitySource: measurement.source,
            popularityRef: measurement.ref,
            popularityRaw: Math.round(measurement.raw),
            popularityCohort: measurement.cohort,
          })
          .where(D.eq(targetTable.id, measurement.targetId))
          .run();
      }
    });
  }
  console.log(`[write] ${writable.length} rows ranked`);
}

/* -- main ----------------------------------------------------------------- */

async function main() {
  const started = Date.now();
  const overrides = await loadOverrides();
  const targets = await webTargets();
  console.log(
    `[popularity] ${targets.length} targets without stars of their own`,
  );

  const candidates: RepoCandidate[] = [];
  const native: Measurement[] = [];
  const ranSources: PopularitySource[] = [];
  let heldBack: RepoCandidate[] = [];

  if (!flags["skip-inherited"]) {
    const pass = await inheritedCandidates(targets, overrides);
    candidates.push(...pass.candidates);
    heldBack = pass.heldBack;
    ranSources.push("inherited");
  }

  if (!flags["skip-registries"]) {
    const pass = await registryMeasurements(targets);
    candidates.push(...pass.candidates);
    native.push(...pass.native);
    ranSources.push("registryRepo", "registryNative");
  }

  if (!flags["skip-forges"]) {
    native.push(...(await forgeMeasurements(targets)));
    ranSources.push("forge");
  }

  const measurements = [...(await starsForCandidates(candidates)), ...native];

  const distribution = (
    await db
      .select({ stars: targetTable.stars })
      .from(targetTable)
      .where(
        D.and(D.eq(targetTable.kind, "github"), D.isNotNull(targetTable.stars)),
      )
  ).map((row) => row.stars!);

  const { popularity, dropped } = starEquivalents(measurements, distribution);
  for (const { cohort, rows } of dropped) {
    console.log(
      `[calibrate] ${cohort}: ${rows} rows, too few to rank, left out`,
    );
  }

  await persist(measurements, popularity, ranSources);

  const bySource = new Map<string, number>();
  for (const measurement of measurements) {
    if (!popularity.has(measurement.targetId)) continue;
    bySource.set(
      measurement.source,
      (bySource.get(measurement.source) ?? 0) + 1,
    );
  }
  for (const [source, count] of [...bySource].sort((a, b) => b[1] - a[1])) {
    console.log(`[popularity] ${source}: ${count}`);
  }
  console.log(
    `[popularity] ${popularity.size} of ${targets.length} ranked ` +
      `(${((100 * popularity.size) / targets.length).toFixed(1)}%) in ` +
      `${Math.round((Date.now() - started) / 1000)}s`,
  );

  if (flags.report && heldBack.length > 0) {
    console.log(
      `\nHeld back by minInheritedStars=${overrides.minInheritedStars}. Roughly ` +
        `a third of these are the wrong repository; list those under ` +
        `"rejected" in popularity.yaml, then lower the floor.\n`,
    );
    const repos = await db
      .select({ id: targetTable.id, stars: targetTable.stars })
      .from(targetTable)
      .where(D.eq(targetTable.kind, "github"));
    const starsOf = new Map(repos.map((r) => [r.id, r.stars ?? 0]));
    for (const candidate of heldBack.sort(
      (a, b) => (starsOf.get(a.repoId) ?? 0) - (starsOf.get(b.repoId) ?? 0),
    )) {
      console.log(
        `  ${String(starsOf.get(candidate.repoId) ?? 0).padStart(5)}  ` +
          `${candidate.via.padEnd(34)} ${candidate.repoId}`,
      );
    }
  }
}

await main();
