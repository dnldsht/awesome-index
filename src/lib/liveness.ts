import { lookup } from "node:dns/promises";

/**
 * Whether a link still answers.
 *
 * For a repository the site's signal is `pushedAt`: nobody has to ask GitHub
 * whether tokio exists, the API says so and says when it last moved. A website
 * has no such API, and the one thing that can be known about it from outside is
 * whether it is still there, which is the more useful half anyway, because link
 * rot on a personal domain is far worse than on github.com. A list from 2016 has
 * entries whose repositories are merely quiet and entries whose domains are now
 * parked, and only the second kind is actually gone.
 *
 * The hard part is not the request, it is not lying. A GET that does not come
 * back with a 200 is usually not a dead link:
 *
 * - Cloudflare and friends answer 403 to anything without a browser's
 *   fingerprint, and a great many project sites sit behind them;
 * - 429 means we were impolite, which is our fault, not the site's;
 * - a 5xx is a bad ten minutes, not a closed project;
 * - a timeout is whatever the runner's network was doing at the time.
 *
 * So the outcome is three-valued: `ok`, `dead` for the handful of failures that
 * really do mean "there is nothing here", and `unknown` for everything else,
 * which changes nothing about a row except when we last looked. And even `dead`
 * only marks a target after `DEAD_AFTER` consecutive crawls agree: a DNS
 * resolver having a bad night in CI would otherwise mark thousands of live
 * projects dead in one run, and one wrong "dead link" badge costs more trust
 * than a hundred rows that say nothing at all.
 */

/**
 * How far a redirect chain is followed. Each hop is checked against the guard
 * below before it is requested, which is the reason the chain is walked here
 * rather than handed to `redirect: "follow"`: a public URL that redirects to
 * 127.0.0.1 would otherwise be fetched with nobody having looked at where it
 * ended up.
 */
const MAX_REDIRECTS = 5;

/** how many consecutive hard failures it takes to call a link dead */
export const DEAD_AFTER = 2;

/** long enough for a slow personal server, short enough for 5,000 of them */
export const PROBE_TIMEOUT_MS = 10_000;

/**
 * Identifies the crawler and points at the site, so an administrator reading
 * their logs can tell what this is and where it came from. One request per URL
 * per week is not a crawl of anybody's site, but it should still say who it is.
 */
const USER_AGENT =
  "AwesomeIndexBot/1.0 (+https://awesome.donld.me/; one request per link per week)";

/**
 * Hosts this crawler will not ask about, whatever a README says.
 *
 * Every URL here was written by a stranger (an awesome list takes pull requests),
 * and this pass turns each one into an outbound GET from a CI runner and from
 * whoever runs `pnpm crawl` on their own machine, i.e. from inside their network.
 * Without this, a single merged line ("- [Router](http://192.168.1.1/reboot)")
 * points our request at a private address, and the site then publishes whether it
 * answered: a reachability oracle for someone else's LAN, one bit at a time, and
 * a GET at a device that may act on GETs.
 *
 * The rule is "must be a public name or address", not a list of bad ones, since
 * the interesting addresses are the ones nobody thinks to enumerate.
 */
const PRIVATE_V4 = [
  /^0\./,
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
  /^198\.1[89]\./,
  /^(22[4-9]|23\d|24\d|25\d)\./,
];

const PRIVATE_SUFFIX =
  /(^|\.)(localhost|local|internal|intranet|home\.arpa|test|invalid|example)$/i;

/** true for a literal IPv4 address in a range that is not routable on the internet */
const isPrivateV4 = (host: string) =>
  PRIVATE_V4.some((range) => range.test(host));

/**
 * The address a name is not allowed to be, whether it says so or resolves to it.
 *
 * Two rounds, because a name can lie. `127.0.0.1.nip.io` is a public hostname
 * with a public suffix and a dot in the middle, and it resolves to loopback; so
 * do a good many "convenience" DNS services. Names are therefore resolved and
 * every address checked, not just parsed.
 *
 * What this cannot close on its own is the gap between the lookup and the
 * connection: a name with a one-second TTL can answer differently the second
 * time (DNS rebinding). Pinning the resolved address into the socket is the only
 * complete answer, and it is not worth an HTTP dispatcher of our own for the
 * thing being protected here: one bit about a host, on a machine that holds no
 * secrets a GET could read.
 */
function blockedByAddress(addresses: string[]): string | undefined {
  for (const address of addresses) {
    const host = address.toLowerCase();
    if (host === "::1" || host === "::") return "loopback";
    if (/^f[cd]/.test(host) || /^fe[89ab]/.test(host)) return "private address";
    if (isPrivateV4(host)) return "private address";
    // ::ffff:127.0.0.1 hides a v4 address in its tail
    const tail = host.slice(host.lastIndexOf(":") + 1);
    if (/^\d+\.\d+\.\d+\.\d+$/.test(tail) && isPrivateV4(tail)) {
      return "private address";
    }
  }
  return undefined;
}

/** the reason a URL is not ours to fetch, or undefined when it is */
function blockedReason(url: URL): string | undefined {
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return `scheme ${url.protocol}`;
  }

  /*
   * Only the ports the web is served on.
   *
   * `URL` leaves `port` empty for 80 on http and 443 on https, so this rejects
   * exactly the explicit ones, and with them the sharpest edge of the oracle
   * this pass would otherwise be: twenty entries pointing at
   * `http://host:6379/`, `:9200`, `:8080` and the rest is a port scan whose
   * results we would publish. A project whose site really lives on :8080 keeps
   * its row and its link; it just never gets a reachability badge.
   */
  if (url.port) return `port ${url.port}`;

  // URL keeps IPv6 literals in brackets, and a trailing dot is a legal way to
  // write a fully qualified name ("localhost." resolves to loopback) that would
  // otherwise walk straight past every check below
  const host = url.hostname
    .replace(/^\[|\]$/g, "")
    .replace(/\.+$/, "")
    .toLowerCase();
  if (!host) return "no host";

  if (PRIVATE_SUFFIX.test(host)) return "private suffix";

  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":")) {
    return blockedByAddress([host]);
  }

  // a single-label name ("router", "wiki") only resolves inside a network, and
  // no project's website is one
  if (!host.includes(".")) return "single label host";

  return undefined;
}

/**
 * The same question asked of DNS, for the names that pass the parse.
 *
 * A lookup that fails is not a block: that is what the request itself is for,
 * and `ENOTFOUND` from the fetch is the signal that a domain has lapsed, which is
 * the whole point of this pass.
 */
async function blockedByLookup(url: URL): Promise<string | undefined> {
  const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.+$/, "");
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":")) {
    return undefined; // a literal address was already checked as one
  }
  try {
    const records = await lookup(host, { all: true, verbatim: true });
    return blockedByAddress(records.map((record) => record.address));
  } catch {
    return undefined;
  }
}

/** credentials in a link are not ours to replay, and not ours to log either */
function withoutCredentials(url: URL): string {
  if (!url.username && !url.password) return url.href;
  const clean = new URL(url.href);
  clean.username = "";
  clean.password = "";
  return clean.href;
}

export type Probe =
  /** it answered */
  | { outcome: "ok"; status: number }
  /** there is nothing there: no such host, refused, or a 404/410 */
  | { outcome: "dead"; reason: string }
  /** we could not tell, which is not the same as bad news */
  | { outcome: "unknown"; reason: string };

/**
 * Node reports the interesting part of a network failure as a `code` on the
 * error or on its `cause`. Only two of them mean the address itself is gone.
 */
function codeOf(error: unknown): string {
  const err = error as {
    code?: string;
    cause?: { code?: string };
    name?: string;
  };
  return err?.cause?.code ?? err?.code ?? err?.name ?? "unknown";
}

const DEAD_CODES = new Set([
  // the hostname does not resolve at all: the domain lapsed, or never was
  "ENOTFOUND",
  "EAI_NODATA",
  // something is at the address and it is not serving anything
  "ECONNREFUSED",
]);

export async function probeLink(
  url: string,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<Probe> {
  let current: URL;
  try {
    current = new URL(url);
  } catch {
    return { outcome: "unknown", reason: "unparseable" };
  }

  // one deadline for the whole chain, not one per hop: five hops of ten seconds
  // is a minute spent on one row
  const signal = AbortSignal.timeout(timeoutMs);

  for (let hop = 0; ; hop++) {
    const blocked = blockedReason(current) ?? (await blockedByLookup(current));
    // never a verdict on the link, because no request was made: this says
    // something about us, not about the page
    if (blocked) return { outcome: "unknown", reason: `blocked: ${blocked}` };

    let response: Response;
    try {
      response = await fetch(withoutCredentials(current), {
        // GET, not HEAD: plenty of hosts answer 405 to a HEAD, and a 405 would
        // then have to be read as "alive, probably", which is a worse signal than
        // the one byte of body this costs. The body is cancelled below rather than
        // read, so nothing is actually downloaded.
        method: "GET",
        // followed by hand, see MAX_REDIRECTS
        redirect: "manual",
        headers: {
          "user-agent": USER_AGENT,
          accept: "text/html,application/xhtml+xml,*/*;q=0.8",
          "accept-language": "en",
        },
        signal,
      });
    } catch (error) {
      const code = codeOf(error);
      if (DEAD_CODES.has(code)) return { outcome: "dead", reason: code };
      // everything else (a bad certificate, a reset, a timeout, a DNS server
      // that shrugged with EAI_AGAIN) says something about the network between us
      // and the page, not about the page
      return { outcome: "unknown", reason: code };
    }

    // headers are all we wanted; let the socket go without reading the body
    void response.body?.cancel().catch(() => {});

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) {
        return { outcome: "unknown", reason: `${response.status} no location` };
      }
      if (hop >= MAX_REDIRECTS) {
        return { outcome: "unknown", reason: "too many redirects" };
      }
      try {
        current = new URL(location, current);
      } catch {
        return { outcome: "unknown", reason: "bad redirect" };
      }
      continue;
    }

    if (response.status < 400)
      return { outcome: "ok", status: response.status };
    if (response.status === 404 || response.status === 410) {
      return { outcome: "dead", reason: String(response.status) };
    }
    return { outcome: "unknown", reason: String(response.status) };
  }
}

/**
 * What a probe does to the row it was about.
 *
 * `ok` resets the streak, because a link that answers today is not two thirds of
 * the way to dead. `unknown` touches `checkedAt` and nothing else. In
 * particular it does *not* reset the streak, so a site alternating between 404
 * and a timeout still gets there, and it does not advance it either.
 */
export function applyProbe(
  probe: Probe,
  current: { failStreak: number; status: "ok" | "dead" | null },
  now: Date,
): {
  status: "ok" | "dead" | null;
  checkedAt: Date;
  lastOkAt?: Date;
  failStreak: number;
} {
  if (probe.outcome === "ok") {
    return { status: "ok", checkedAt: now, lastOkAt: now, failStreak: 0 };
  }
  if (probe.outcome === "dead") {
    const failStreak = current.failStreak + 1;
    return {
      status: failStreak >= DEAD_AFTER ? "dead" : current.status,
      checkedAt: now,
      failStreak,
    };
  }
  return {
    status: current.status,
    checkedAt: now,
    failStreak: current.failStreak,
  };
}
