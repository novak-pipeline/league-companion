import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * Small JSON cache on disk.
 *
 * Everything the app pulls from the network (Data Dragon, Riot API samples) is
 * cached so the app works offline and so a rate-limited API key is not burned
 * re-fetching data that has not changed. Entries carry the patch they were
 * fetched for, which is what actually invalidates them — a TTL alone would
 * either refetch pointlessly mid-patch or serve stale data across a patch.
 */

export interface CacheEntry<T> {
  /** Patch the data belongs to, e.g. "26.14.1". Null when patch-independent. */
  patch: string | null;
  fetchedAt: string;
  data: T;
}

export class JsonCache {
  constructor(private readonly rootDir: string) {}

  private pathFor(key: string): string {
    // Keys may contain slashes to namespace; keep them as directories.
    const safe = key.replace(/[^a-zA-Z0-9/_.-]/g, '_');
    return join(this.rootDir, `${safe}.json`);
  }

  async read<T>(key: string): Promise<CacheEntry<T> | null> {
    try {
      const raw = await readFile(this.pathFor(key), 'utf8');
      return JSON.parse(raw) as CacheEntry<T>;
    } catch {
      return null;
    }
  }

  async write<T>(key: string, data: T, patch: string | null = null): Promise<void> {
    const file = this.pathFor(key);
    await mkdir(dirname(file), { recursive: true });
    const entry: CacheEntry<T> = { patch, fetchedAt: new Date().toISOString(), data };
    await writeFile(file, JSON.stringify(entry, null, 2), 'utf8');
  }

  /**
   * Returns cached data when it is still good, otherwise runs `fetcher` and
   * caches the result. Cache is considered stale when the patch changed or the
   * entry is older than `maxAgeMs`.
   *
   * A failing fetch falls back to stale cache rather than throwing — a patch-old
   * win rate is far more useful than an empty panel.
   */
  async getOrFetch<T>(
    key: string,
    opts: { patch?: string | null; maxAgeMs?: number },
    fetcher: () => Promise<T>,
  ): Promise<{ data: T; fromCache: boolean; stale: boolean } | null> {
    const cached = await this.read<T>(key);
    const patch = opts.patch ?? null;
    const maxAge = opts.maxAgeMs ?? Infinity;

    if (cached) {
      const ageMs = Date.now() - new Date(cached.fetchedAt).getTime();
      const patchMatches = patch === null || cached.patch === patch;
      if (patchMatches && ageMs < maxAge) {
        return { data: cached.data, fromCache: true, stale: false };
      }
    }

    try {
      const fresh = await fetcher();
      await this.write(key, fresh, patch);
      return { data: fresh, fromCache: false, stale: false };
    } catch {
      if (cached) return { data: cached.data, fromCache: true, stale: true };
      return null;
    }
  }
}
