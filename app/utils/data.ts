/**
 * One file from `/data/`, read wherever the code happens to be running.
 *
 * In the browser it is a fetch. During `nuxt generate` it is a read from disk,
 * because the prerender server does not serve `public/` (nor the fixtures
 * mounted over it): asked for `/data/golang.json` it answers 404, and the page
 * would be written out empty without anyone noticing. Reading the file
 * is what puts the rows into the HTML a crawler sees.
 *
 * Deliberately not `useAsyncData`. That would serialise the shard into the
 * page's payload, so the reader downloads every row twice (once as HTML, once
 * as payload) and the payload is larger than the shard it copies. Awaited in
 * the page's setup instead, the browser fetches the shard itself before it
 * hydrates, the same request the page made before rows were prerendered, and
 * the payload carries nothing.
 */
export async function useData<T>(name: string) {
  const data = shallowRef<T | null>(null);
  const error = shallowRef<unknown>(null);
  try {
    data.value = await loadData<T>(name);
  } catch (e) {
    error.value = e;
  }
  return { data, error };
}

async function loadData<T>(name: string): Promise<T> {
  if (import.meta.server) {
    const dir = useRuntimeConfig().dataDir as string;
    const { readFile } = await import("node:fs/promises");
    return JSON.parse(await readFile(`${dir}/${name}.json`, "utf8")) as T;
  }
  return $fetch(`/data/${name}.json`) as Promise<T>;
}
