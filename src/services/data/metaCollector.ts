import type { ChampionMetaStats, MetaSnapshot, Role } from '../../core/types.js';
import type { JsonCache } from './cache.js';
import { RiotApiClient, shortPatch, type MatchDetail } from './riotApi.js';

/**
 * Builds a local meta dataset from real matches.
 *
 * Riot publishes no aggregate win-rate endpoint, so sites like u.gg compute
 * theirs by sampling matches at scale. This does the same thing on a smaller
 * budget: seed from the top of the ladder, walk those players' recent ranked
 * games, and accumulate per-champion outcomes into a patch-keyed tally.
 *
 * It is deliberately incremental. A development key cannot pull a statistically
 * strong sample in one go, so the collector runs in the background, dedupes by
 * match id, and keeps adding. Every number it produces carries the `games` it
 * came from so the UI can refuse to show a win rate built on 4 matches.
 */

const RANKED_SOLO_QUEUE = 420;

interface ChampionTally {
  games: number;
  wins: number;
  byRole: Record<string, { games: number; wins: number }>;
}

export interface MetaState {
  patch: string;
  updatedAt: string;
  /** Match ids already counted, so re-runs do not double-count. */
  seenMatchIds: string[];
  totalMatches: number;
  tallies: Record<string, ChampionTally>;
}

const ROLE_MAP: Record<string, Role> = {
  TOP: 'top',
  JUNGLE: 'jungle',
  MIDDLE: 'mid',
  BOTTOM: 'adc',
  UTILITY: 'support',
};

function emptyState(patch: string): MetaState {
  return {
    patch,
    updatedAt: new Date().toISOString(),
    seenMatchIds: [],
    totalMatches: 0,
    tallies: {},
  };
}

/** Folds one match into the tally. Ignores non-ranked and remakes. */
export function accumulateMatch(state: MetaState, match: MatchDetail): boolean {
  const matchId = match.metadata.matchId;
  if (state.seenMatchIds.includes(matchId)) return false;
  if (match.info.queueId !== RANKED_SOLO_QUEUE) return false;
  // Remakes poison win rates; anything under 5 minutes is not a real game.
  if (match.info.gameDuration < 300) return false;

  const patch = shortPatch(match.info.gameVersion);
  if (patch !== state.patch) return false;

  state.seenMatchIds.push(matchId);
  state.totalMatches += 1;

  for (const p of match.info.participants) {
    const tally = state.tallies[p.championName] ?? { games: 0, wins: 0, byRole: {} };
    tally.games += 1;
    if (p.win) tally.wins += 1;

    const role = ROLE_MAP[p.teamPosition];
    if (role) {
      const roleTally = tally.byRole[role] ?? { games: 0, wins: 0 };
      roleTally.games += 1;
      if (p.win) roleTally.wins += 1;
      tally.byRole[role] = roleTally;
    }

    state.tallies[p.championName] = tally;
  }

  state.updatedAt = new Date().toISOString();
  return true;
}

/** Converts the raw tally into the snapshot the UI and draft engine consume. */
export function toSnapshot(state: MetaState): MetaSnapshot {
  const byChampion: ChampionMetaStats[] = [];

  for (const [championId, tally] of Object.entries(state.tallies)) {
    byChampion.push({
      championId,
      games: tally.games,
      wins: tally.wins,
      winRate: tally.games === 0 ? 0 : Number(((tally.wins / tally.games) * 100).toFixed(1)),
      // Ten participants per match, so appearing in every match would be 1000%
      // of matches by participant count; normalize against matches, not slots.
      pickRate:
        state.totalMatches === 0
          ? 0
          : Number(((tally.games / state.totalMatches) * 100).toFixed(1)),
      patch: state.patch,
    });

    for (const [role, roleTally] of Object.entries(tally.byRole)) {
      if (roleTally.games === 0) continue;
      byChampion.push({
        championId,
        role: role as Role,
        games: roleTally.games,
        wins: roleTally.wins,
        winRate: Number(((roleTally.wins / roleTally.games) * 100).toFixed(1)),
        pickRate:
          state.totalMatches === 0
            ? 0
            : Number(((roleTally.games / state.totalMatches) * 100).toFixed(1)),
        patch: state.patch,
      });
    }
  }

  return {
    patch: state.patch,
    updatedAt: state.updatedAt,
    sampleSize: state.totalMatches,
    source: state.totalMatches > 0 ? 'riot-api-sample' : 'none',
    byChampion,
  };
}

export interface CollectOptions {
  /** How many matches to pull this run. Keep small; the collector is resumable. */
  matchBudget: number;
  /** How many ladder players to seed from. */
  seedPlayers: number;
  /** Called after each match so the UI can show progress. */
  onProgress?: (collected: number, budget: number) => void;
  /** Set to abort a long-running collection. */
  signal?: AbortSignal;
}

/**
 * Runs one incremental collection pass and persists the result.
 *
 * Returns the updated snapshot. Safe to call repeatedly — each pass extends the
 * sample rather than replacing it.
 */
export async function collectMeta(
  client: RiotApiClient,
  cache: JsonCache,
  patch: string,
  opts: CollectOptions,
): Promise<MetaSnapshot> {
  const key = `meta/state-${patch}`;
  const existing = await cache.read<MetaState>(key);
  const state: MetaState =
    existing?.data && existing.data.patch === patch ? existing.data : emptyState(patch);

  let collected = 0;

  try {
    const league = await client.getChallengerLeague();
    const seeds = league.entries
      .map((e) => e.puuid)
      .filter((p): p is string => Boolean(p))
      .slice(0, opts.seedPlayers);

    for (const puuid of seeds) {
      if (collected >= opts.matchBudget || opts.signal?.aborted) break;

      const matchIds = await client.getMatchIds(puuid, {
        count: 10,
        queue: RANKED_SOLO_QUEUE,
      });

      for (const matchId of matchIds) {
        if (collected >= opts.matchBudget || opts.signal?.aborted) break;
        if (state.seenMatchIds.includes(matchId)) continue;

        try {
          const match = await client.getMatch(matchId);
          if (accumulateMatch(state, match)) {
            collected += 1;
            opts.onProgress?.(collected, opts.matchBudget);
          }
        } catch {
          // One bad match should not end the pass.
          continue;
        }
      }
    }
  } finally {
    // Persist whatever was gathered, even on abort or partial failure.
    // Cap the dedupe list so it cannot grow without bound across a patch.
    if (state.seenMatchIds.length > 50_000) {
      state.seenMatchIds = state.seenMatchIds.slice(-50_000);
    }
    await cache.write(key, state, patch);
  }

  return toSnapshot(state);
}

/** Loads the stored meta without hitting the network. */
export async function loadMeta(cache: JsonCache, patch: string): Promise<MetaSnapshot | null> {
  const entry = await cache.read<MetaState>(`meta/state-${patch}`);
  if (!entry?.data || entry.data.patch !== patch) return null;
  return toSnapshot(entry.data);
}
