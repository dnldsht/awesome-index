import { Octokit } from "octokit";
import {
  PARSER_VERSION,
  parseAwesomeReadme,
  type ParsedItem,
} from "./readme.ts";

/**
 * The 5000 req/hour budget is per *account*, so several tokens only add up when
 * they belong to different users. Comma separated, most privileged first.
 */
const tokens = (process.env["GITHUB_TOKEN"] ?? "")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

let index = 0;
let client: Octokit | undefined;

export function getOctokit(): Octokit {
  if (tokens.length === 0) {
    throw new Error("GITHUB_TOKEN is not set");
  }
  // the crawler drives its own backoff, the plugin retrying underneath would
  // just hide the rate limit from the loop that knows how to rotate tokens
  client ??= new Octokit({
    auth: tokens[index],
    throttle: { onRateLimit: () => false, onSecondaryRateLimit: () => false },
  });
  return client;
}

/** moves to the next token. false means they are all spent for this window. */
export function rotateOctokit(): boolean {
  if (index >= tokens.length - 1) return false;
  index++;
  client = undefined;
  return true;
}

/** after waiting out a reset window every token is worth trying again */
export function resetOctokitRotation(): void {
  if (index === 0) return;
  index = 0;
  client = undefined;
}

export type GithubProject = {
  id: string;
  description: string;
  homepageUrl: string | null;
  topics: string[];
  ownerLogin: string;
  ownerAvatarUrl: string;
  stars: number;
  forks: number;
  license: string | null;
  primaryLanguage: string;
  archived: boolean;
  pushedAt: Date;
  createdAt: Date;
};

const REPO_FIELDS = `
fragment repoFields on Repository {
  nameWithOwner
  description
  homepageUrl
  isArchived
  stargazerCount
  forkCount
  pushedAt
  createdAt
  licenseInfo { name }
  primaryLanguage { name }
  repositoryTopics(first: 10) { nodes { topic { name } } }
  owner { login avatarUrl }
}`;

/**
 * The homepage field as something safe to put in an `href`.
 *
 * GitHub takes whatever the owner typed into the Website box: it is usually a
 * full url, but "tokio.rs" and "  " are both common, and plenty of projects
 * point it back at their own repository, which the card already links. A
 * scheme-less value is read as https rather than dropped, since that is what
 * the owner meant, and anything that is not http(s) (a `javascript:` url, a
 * mailto, a typo that does not parse) becomes null instead of reaching the page.
 */
export function normalizeHomepage(
  raw: string | null | undefined,
  repoId: string,
): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;

  let url: URL;
  try {
    url = new URL(
      /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`,
    );
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;

  // "the website is the repo" carries nothing the GitHub link does not
  const host = url.hostname.replace(/^www\./, "").toLowerCase();
  if (host === "github.com") {
    const path = url.pathname.replace(/^\/+|\/+$/g, "").toLowerCase();
    if (path === repoId.toLowerCase()) return null;
  }

  return url.href;
}

/**
 * Refreshes a whole batch of repositories with a single request.
 *
 * The REST endpoint costs 2 requests per repository, which does not fit the
 * hourly budget for a ~20k repository dataset. One GraphQL call resolves up to
 * 100 aliases for 1 rate limit point and returns the primary language inline,
 * so the extra listLanguages round trip disappears too.
 */
export async function fetchGithubProjects(ids: string[]) {
  const octokit = getOctokit();

  const varDefs: string[] = [];
  const selections: string[] = [];
  const variables: Record<string, string> = {};

  ids.forEach((id, i) => {
    const [owner, repo] = id.split("/");
    varDefs.push(`$o${i}: String!`, `$n${i}: String!`);
    selections.push(
      `r${i}: repository(owner: $o${i}, name: $n${i}) { ...repoFields }`,
    );
    variables[`o${i}`] = owner!;
    variables[`n${i}`] = repo!;
  });

  const query = `query batch(${varDefs.join(", ")}) {
  rateLimit { cost remaining resetAt }
  ${selections.join("\n  ")}
}${REPO_FIELDS}`;

  let data: any;
  try {
    data = await octokit.graphql(query, variables);
  } catch (error: any) {
    // a NOT_FOUND on any single alias rejects the whole call, but the payload
    // still carries every repository that did resolve
    if (error && typeof error === "object" && "data" in error && error.data) {
      data = error.data;
    } else {
      throw error;
    }
  }

  const projects = new Map<string, GithubProject>();
  ids.forEach((id, i) => {
    const node = data[`r${i}`];
    if (!node) return;
    projects.set(id, {
      id: node.nameWithOwner,
      description: node.description ?? "",
      homepageUrl: normalizeHomepage(node.homepageUrl, node.nameWithOwner),
      topics: (node.repositoryTopics?.nodes ?? []).map(
        (x: any) => x.topic.name,
      ),
      // rendered as a github.com/<login> link, so it has to stay the login
      ownerLogin: node.owner.login,
      ownerAvatarUrl: node.owner.avatarUrl,
      stars: node.stargazerCount ?? 0,
      forks: node.forkCount ?? 0,
      license: node.licenseInfo?.name ?? null,
      primaryLanguage: node.primaryLanguage?.name ?? "",
      archived: Boolean(node.isArchived),
      pushedAt: new Date(node.pushedAt ?? node.createdAt),
      createdAt: new Date(node.createdAt),
    });
  });

  return {
    projects,
    missing: ids.filter((id) => !projects.has(id)),
    rateLimit: data.rateLimit as
      { cost: number; remaining: number; resetAt: string } | undefined,
  };
}

export type FetchedList = {
  readmeDigest: string;
  items: ParsedItem[];
};

/** reads a list README and returns the repositories it links, with their sections */
export async function fetchAwesomeList(id: string): Promise<FetchedList> {
  const octokit = getOctokit();
  const [owner, repo] = id.split("/");
  const { data } = await octokit.rest.repos.getReadme({
    owner: owner!,
    repo: repo!,
  });

  const markdown = Buffer.from(data.content, "base64").toString("utf-8");
  return {
    // the blob sha alone would keep an unchanged README on a stale parse, see
    // PARSER_VERSION
    readmeDigest: `v${PARSER_VERSION}:${data.sha}`,
    items: parseAwesomeReadme(markdown, { exclude: id }),
  };
}
