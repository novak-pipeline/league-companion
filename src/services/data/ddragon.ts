import type { ChampClass, ChampionData, DamageProfile } from '../../core/types.js';
import type { JsonCache } from './cache.js';

/**
 * Data Dragon — Riot's official static data CDN.
 *
 * No API key, no rate limit, and it is versioned per patch, so this is the
 * authoritative source for anything structural: which champions exist, their
 * exact Riot ids, attack ranges, and class tags. It is how the app stays
 * current when Riot ships a new champion or reworks an old one.
 *
 * https://developer.riotgames.com/docs/lol#data-dragon
 */

const BASE = 'https://ddragon.leagueoflegends.com';

interface DDragonChampion {
  id: string;
  key: string;
  name: string;
  title: string;
  tags: string[];
  info: { attack: number; defense: number; magic: number; difficulty: number };
  stats: { attackrange: number; hp: number; armor: number; spellblock: number };
  partype: string;
}

interface DDragonChampionFile {
  version: string;
  data: Record<string, DDragonChampion>;
}

/** Riot's tags map onto our narrower class vocabulary. */
const TAG_MAP: Record<string, ChampClass> = {
  Tank: 'tank',
  Fighter: 'fighter',
  Assassin: 'assassin',
  Mage: 'mage',
  Marksman: 'marksman',
  // Riot lumps every support into one tag; the curated table splits enchanters
  // from catchers, so an un-curated support defaults to the safer 'enchanter'.
  Support: 'enchanter',
};

async function getJson<T>(url: string, timeoutMs = 8000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`${url} returned ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

/** Newest patch version string, e.g. "26.14.1". */
export async function fetchLatestVersion(): Promise<string> {
  const versions = await getJson<string[]>(`${BASE}/api/versions.json`);
  const latest = versions[0];
  if (!latest) throw new Error('Data Dragon returned no versions');
  return latest;
}

export async function fetchChampionFile(version: string): Promise<DDragonChampionFile> {
  return getJson<DDragonChampionFile>(`${BASE}/cdn/${version}/data/en_US/champion.json`);
}

/**
 * Derives a champion profile from Data Dragon alone.
 *
 * Riot does not publish damage-type or utility ratings, so the judgement fields
 * are inferred conservatively and are meant to be *overridden* by the curated
 * table where one exists. This path exists so a champion released after the
 * curated table was written still shows up with a usable profile instead of
 * being invisible to the draft tool.
 */
export function deriveFromDDragon(champ: DDragonChampion): ChampionData {
  const classes = champ.tags
    .map((t) => TAG_MAP[t])
    .filter((c): c is ChampClass => c !== undefined);

  // `info.attack` / `info.magic` are Riot's 0-10 flavour ratings. They are a
  // weak signal for damage type but the only one available here.
  let damage: DamageProfile = 'mixed';
  if (champ.info.magic >= champ.info.attack + 3) damage = 'magic';
  else if (champ.info.attack >= champ.info.magic + 3) damage = 'physical';

  // Melee ranges cluster around 125-175; ranged start at 500. 300 splits them
  // with a wide margin either side.
  const range = champ.stats.attackrange >= 300 ? 'ranged' : 'melee';

  return {
    id: champ.id,
    name: champ.name,
    classes: classes.length > 0 ? classes : ['fighter'],
    damage,
    range,
    // Neutral midpoints: unknown, not zero. Zero would actively mislead the
    // comp analyser into thinking the champion brings nothing.
    cc: 1,
    engage: 1,
    peel: 1,
    waveclear: 2,
    scaling: 'mid',
    roles: [],
  };
}

export interface DDragonSnapshot {
  version: string;
  champions: ChampionData[];
  /** Raw ranges/tags kept so the curated table can be validated against Riot. */
  raw: Record<string, { attackrange: number; tags: string[]; name: string }>;
  /**
   * Riot's numeric champion key -> Data Dragon id. Champ select identifies
   * champions numerically, so this mapping is what makes the draft reader work.
   */
  numericKeys: Record<string, string>;
}

/**
 * Pulls the current patch's champion list, cached per patch.
 * Returns null when offline with nothing cached.
 */
export async function loadDDragon(
  cache: JsonCache,
  maxAgeMs = 6 * 60 * 60 * 1000,
): Promise<DDragonSnapshot | null> {
  // The version list itself is cheap and is what tells us a patch landed.
  const versionResult = await cache.getOrFetch<string>(
    'ddragon/version',
    { maxAgeMs },
    fetchLatestVersion,
  );
  if (!versionResult) return null;
  const version = versionResult.data;

  const championResult = await cache.getOrFetch<DDragonSnapshot>(
    `ddragon/champions-${version}`,
    { patch: version },
    async () => {
      const file = await fetchChampionFile(version);
      const champions = Object.values(file.data).map(deriveFromDDragon);
      const raw: DDragonSnapshot['raw'] = {};
      const numericKeys: DDragonSnapshot['numericKeys'] = {};
      for (const c of Object.values(file.data)) {
        raw[c.id] = { attackrange: c.stats.attackrange, tags: c.tags, name: c.name };
        numericKeys[c.key] = c.id;
      }
      return { version, champions, raw, numericKeys };
    },
  );

  return championResult?.data ?? null;
}
