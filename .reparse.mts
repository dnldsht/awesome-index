/** throwaway: re-parse every list (raw READMEs, no token) after the slug change */
import * as D from "drizzle-orm";
import PQueue from "p-queue";
import { loadConfig } from "./src/lib/config.ts";
import { db } from "./src/lib/db/client.ts";
import { awesomeItemTable, awesomeListTable, targetTable } from "./src/lib/db/schema.ts";
import { PARSER_VERSION, parseAwesomeReadme } from "./src/lib/readme.ts";

const BRANCHES = ["master", "main", "gh-pages"];
const FILES = ["README.md", "readme.md", "Readme.md", "README.markdown", "README.org", "README.rst", "readme.org"];
async function readme(id: string) {
  for (const b of BRANCHES) for (const f of FILES) {
    const r = await fetch(`https://raw.githubusercontent.com/${id}/${b}/${f}`);
    if (r.ok) return { text: await r.text(), where: `${b}/${f}` };
  }
}
function chunk<T>(a: T[], n: number) { const o: T[][] = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; }

const sourceIds = [...new Set((await loadConfig()).flatMap((e) => e.sourceIds))];
let entries = 0, links = 0, failed: string[] = [];
const queue = new PQueue({ concurrency: 6 });
await queue.addAll(sourceIds.map((id) => async () => {
  const found = await readme(id);
  if (!found) { failed.push(id); return; }
  const items = parseAwesomeReadme(found.text, { exclude: id });
  entries += items.length;
  links += items.filter((i) => i.target.kind !== "github").length;
  const now = new Date();
  db.transaction((tx) => {
    tx.insert(awesomeListTable).values({ id, readmeDigest: `v${PARSER_VERSION}:raw:${found.where}` })
      .onConflictDoUpdate({ target: awesomeListTable.id, set: { readmeDigest: D.sql`excluded.readme_digest`, updatedAt: now } }).run();
    tx.delete(awesomeItemTable).where(D.eq(awesomeItemTable.listId, id)).run();
    for (const rows of chunk(items, 400)) {
      tx.insert(awesomeItemTable).values(rows.map((i) => ({
        listId: id, targetId: i.target.id, section: i.section, sectionSlug: i.sectionSlug,
        title: i.title, note: i.note, position: i.position,
      }))).run();
    }
    const web = [...new Map(items.filter((i) => i.target.kind !== "github").map((i) => [i.target.id, i.target])).values()];
    for (const rows of chunk(web, 400)) {
      tx.insert(targetTable).values(rows.map((t) => ({ id: t.id, kind: t.kind, url: t.url, refreshedAt: now })))
        .onConflictDoUpdate({ target: targetTable.id, set: { url: D.sql`excluded.url` } }).run();
    }
  });
}));
console.log(`re-parsed ${sourceIds.length - failed.length}/${sourceIds.length} lists: ${entries} entries, ${links} off GitHub`);
if (failed.length) console.log("failed:", failed.join(", "));
