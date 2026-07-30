import type { GameRecord, Role, TimelineSample } from '../../core/types.js';
import type { JsonCache } from './cache.js';
import type { MatchDetail, MatchTimeline, RiotApiClient } from './riotApi.js';

/**
 * Imports the player's real match history into the tracker.
 *
 * This is strictly better than sampling the live client: it is exact, it covers
 * games played before the app was installed, and it knows the actual result of
 * every game. The live tracker remains useful only as a fallback when no API
 * key is configured.
 */

const RANKED_SOLO_QUEUE = 420;

const ROLE_MAP: Record<string, Role> = {
  TOP: 'top',
  JUNGLE: 'jungle',
  MIDDLE: 'mid',
  BOTTOM: 'adc',
  UTILITY: 'support',
};

/** Total CS counts both lane minions and jungle camps. */
function csOf(frame: { minionsKilled: number; jungleMinionsKilled: number }): number {
  return frame.minionsKilled + frame.jungleMinionsKilled;
}

/**
 * Reads one participant's CS at a given minute from the timeline.
 * Returns null when the game ended before that point.
 */
export function csAtMinute(
  timeline: MatchTimeline,
  participantId: number,
  minute: number,
): number | null {
  const targetMs = minute * 60_000;
  let best: number | null = null;

  for (const frame of timeline.info.frames) {
    if (frame.timestamp > targetMs + 30_000) break;
    const pf = frame.participantFrames[String(participantId)];
    if (pf) best = csOf(pf);
  }

  // The last frame must actually be at or past the mark, otherwise the game
  // was shorter than the benchmark and reporting a number would be misleading.
  const lastFrame = timeline.info.frames.at(-1);
  if (!lastFrame || lastFrame.timestamp < targetMs - 30_000) return null;
  return best;
}

/** Builds timeline samples for the local record, one per frame. */
function samplesFor(timeline: MatchTimeline, participantId: number): TimelineSample[] {
  const samples: TimelineSample[] = [];
  for (const frame of timeline.info.frames) {
    const pf = frame.participantFrames[String(participantId)];
    if (!pf) continue;
    samples.push({
      gameTime: Math.round(frame.timestamp / 1000),
      cs: csOf(pf),
      // Per-frame K/D/A is not in participantFrames; the match summary carries
      // the totals, so these stay at zero and the record's top-level counts are
      // the authoritative ones.
      kills: 0,
      deaths: 0,
      assists: 0,
      level: pf.level,
    });
  }
  return samples;
}

/** Counts the player's deaths before the 10-minute mark from timeline events. */
export function deathsBefore(timeline: MatchTimeline, participantId: number, minute: number): number {
  const cutoff = minute * 60_000;
  let deaths = 0;
  for (const frame of timeline.info.frames) {
    for (const event of frame.events) {
      if (event.type !== 'CHAMPION_KILL') continue;
      if (event.timestamp > cutoff) continue;
      if (event.victimId === participantId) deaths += 1;
    }
  }
  return deaths;
}

/**
 * Converts a match (plus optional timeline) into a stored record.
 * Returns null when the player is not in the match.
 */
export function toGameRecord(
  match: MatchDetail,
  puuid: string,
  timeline: MatchTimeline | null,
): GameRecord | null {
  const me = match.info.participants.find((p) => p.puuid === puuid);
  if (!me) return null;

  const participantId = timeline?.info.participants.find((p) => p.puuid === puuid)?.participantId;
  const role = ROLE_MAP[me.teamPosition];

  // The direct opponent is whoever played the same position on the other team.
  const opponent = match.info.participants.find(
    (p) => p.teamId !== me.teamId && p.teamPosition === me.teamPosition && me.teamPosition !== '',
  );
  const opponentParticipantId = opponent
    ? timeline?.info.participants.find((p) => p.puuid === opponent.puuid)?.participantId
    : undefined;

  const cs = me.totalMinionsKilled + me.neutralMinionsKilled;
  const minutes = match.info.gameDuration / 60;

  const myCsAt10 =
    timeline && participantId !== undefined ? csAtMinute(timeline, participantId, 10) : null;
  const oppCsAt10 =
    timeline && opponentParticipantId !== undefined
      ? csAtMinute(timeline, opponentParticipantId, 10)
      : null;

  const startedAt = new Date(match.info.gameCreation).toISOString();
  const endedAt = new Date(
    match.info.gameEndTimestamp ?? match.info.gameCreation + match.info.gameDuration * 1000,
  ).toISOString();

  return {
    id: match.metadata.matchId,
    startedAt,
    endedAt,
    gameMode: match.info.gameMode,
    champion: me.championName,
    ...(role ? { role } : {}),
    win: me.win,
    durationSeconds: match.info.gameDuration,
    kills: me.kills,
    deaths: me.deaths,
    assists: me.assists,
    cs,
    csPerMin: minutes > 0 ? Number((cs / minutes).toFixed(1)) : 0,
    csAt10: myCsAt10,
    csAt15:
      timeline && participantId !== undefined ? csAtMinute(timeline, participantId, 15) : null,
    csDiffAt10: myCsAt10 !== null && oppCsAt10 !== null ? myCsAt10 - oppCsAt10 : null,
    deathsBefore10:
      timeline && participantId !== undefined ? deathsBefore(timeline, participantId, 10) : 0,
    laneOpponent: opponent?.championName ?? null,
    samples: timeline && participantId !== undefined ? samplesFor(timeline, participantId) : [],
  };
}

export interface ImportOptions {
  count: number;
  /** Pull per-minute timelines. Doubles the API cost but enables CS@10. */
  includeTimelines: boolean;
  rankedOnly: boolean;
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
}

/**
 * Fetches and converts recent matches, skipping any already stored.
 * Individual failures are skipped rather than aborting the whole import.
 */
export async function importRecentMatches(
  client: RiotApiClient,
  puuid: string,
  existing: GameRecord[],
  opts: ImportOptions,
): Promise<GameRecord[]> {
  const known = new Set(existing.map((g) => g.id));
  const ids = await client.getMatchIds(puuid, {
    count: opts.count,
    ...(opts.rankedOnly ? { queue: RANKED_SOLO_QUEUE } : {}),
  });

  const fresh = ids.filter((id) => !known.has(id));
  const imported: GameRecord[] = [];

  for (const [index, matchId] of fresh.entries()) {
    if (opts.signal?.aborted) break;
    try {
      const match = await client.getMatch(matchId);
      const timeline = opts.includeTimelines ? await client.getMatchTimeline(matchId) : null;
      const record = toGameRecord(match, puuid, timeline);
      if (record) imported.push(record);
    } catch {
      continue;
    }
    opts.onProgress?.(index + 1, fresh.length);
  }

  return imported;
}

/** Caches the resolved account so a Riot ID lookup is not repeated every launch. */
export async function resolveAccount(
  client: RiotApiClient,
  cache: JsonCache,
  gameName: string,
  tagLine: string,
): Promise<{ puuid: string; gameName: string; tagLine: string } | null> {
  const result = await cache.getOrFetch(
    `account/${gameName}-${tagLine}`.toLowerCase(),
    { maxAgeMs: 30 * 24 * 60 * 60 * 1000 },
    () => client.getAccount(gameName, tagLine),
  );
  return result?.data ?? null;
}
