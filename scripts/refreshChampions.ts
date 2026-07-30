/**
 * Refreshes the curated champion table against the current patch.
 *
 * Run with `npm run refresh-champions` on a machine that can reach
 * ddragon.leagueoflegends.com. It does three things:
 *
 *   1. Reports champions Riot has that the curated table is missing, with a
 *      ready-to-paste row using derived defaults.
 *   2. Reports rows whose factual fields disagree with Riot (name, range).
 *   3. Reports curated rows for champions Riot no longer lists.
 *
 * It deliberately does NOT rewrite the table automatically: the judgement
 * fields (cc, engage, peel, waveclear, scaling, roles) cannot be derived, and
 * silently overwriting them with guesses would quietly degrade the draft tool.
 * The app itself merges Data Dragon at runtime, so a new champion still works
 * before anyone gets round to hand-rating it — this script just keeps the
 * checked-in seed honest.
 */

import { CHAMPIONS } from '../src/core/draft/champions.js';

const BASE = 'https://ddragon.leagueoflegends.com';

interface DDragonChampion {
  id: string;
  key: string;
  name: string;
  tags: string[];
  info: { attack: number; defense: number; magic: number; difficulty: number };
  stats: { attackrange: number };
}

async function main(): Promise<void> {
  const versions = (await (await fetch(`${BASE}/api/versions.json`)).json()) as string[];
  const version = versions[0];
  if (!version) throw new Error('Data Dragon returned no versions');

  const file = (await (
    await fetch(`${BASE}/cdn/${version}/data/en_US/champion.json`)
  ).json()) as { data: Record<string, DDragonChampion> };

  const official = Object.values(file.data);
  const curated = new Map(CHAMPIONS.map((c) => [c.id, c]));
  const officialIds = new Set(official.map((c) => c.id));

  console.log(`Data Dragon patch ${version}: ${official.length} champions`);
  console.log(`Curated table: ${CHAMPIONS.length} champions\n`);

  const missing = official.filter((c) => !curated.has(c.id));
  if (missing.length > 0) {
    console.log(`--- ${missing.length} champion(s) missing from the curated table ---`);
    console.log('Paste these into src/core/draft/championData.ts and hand-rate the 0-3 fields:\n');
    for (const c of missing) {
      const classes =
        c.tags
          .map((t) => ({ Tank: 'tank', Fighter: 'fighter', Assassin: 'assassin', Mage: 'mage', Marksman: 'marksman', Support: 'enchanter' })[t])
          .filter(Boolean)
          .join(',') || 'fighter';
      const damage = c.info.magic >= c.info.attack + 3 ? 'M' : c.info.attack >= c.info.magic + 3 ? 'P' : 'X';
      const range = c.stats.attackrange >= 300 ? 'r' : 'm';
      console.log(`  '${c.id}|${c.name}|${classes}|${damage}|${range}|1|1|1|2|m|mid',  // TODO rate`);
    }
    console.log();
  }

  const mismatches: string[] = [];
  for (const c of official) {
    const row = curated.get(c.id);
    if (!row) continue;
    const officialRange = c.stats.attackrange >= 300 ? 'ranged' : 'melee';
    if (row.range !== officialRange) {
      mismatches.push(`  ${c.id}: range is "${row.range}", Riot says "${officialRange}"`);
    }
    if (row.name !== c.name) {
      mismatches.push(`  ${c.id}: name is "${row.name}", Riot says "${c.name}"`);
    }
  }
  if (mismatches.length > 0) {
    console.log(`--- ${mismatches.length} factual mismatch(es) ---`);
    console.log(mismatches.join('\n'));
    console.log();
  }

  const removed = CHAMPIONS.filter((c) => !officialIds.has(c.id));
  if (removed.length > 0) {
    console.log(`--- ${removed.length} curated row(s) Riot no longer lists ---`);
    for (const c of removed) console.log(`  ${c.id} (${c.name}) — check the id spelling`);
    console.log();
  }

  if (missing.length === 0 && mismatches.length === 0 && removed.length === 0) {
    console.log('Curated table is in sync with Data Dragon.');
  }
}

main().catch((error: unknown) => {
  console.error('refresh failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
