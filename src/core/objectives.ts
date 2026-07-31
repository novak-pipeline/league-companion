import type { GameEventRecord } from './types.js';
import { DEFAULT_PATCH, type ObjectiveTiming, type PatchConfig } from './patch.js';

/**
 * Neutral objective availability.
 *
 * First spawns come from the patch config; respawns are derived from the live
 * event feed (Riot reports dragon/herald/baron kills as events). Scuttle deaths
 * are *not* in the event feed, so scuttle respawns are handled as user-started
 * manual timers instead — see `ManualTimer` in types.ts.
 *
 * Note that League's own scoreboard already shows most of these. They are kept
 * here because the companion window is a fine place for them, but they are
 * muted on the overlay by default — duplicating the game's HUD on top of the
 * game is noise, not information.
 */

export type ObjectiveId = 'dragon' | 'grubs' | 'herald' | 'baron' | 'scuttle';

export interface ObjectiveStatus {
  id: ObjectiveId;
  label: string;
  /** Game time (s) it becomes available; null when it will not spawn again. */
  availableAt: number | null;
  /** True when it is currently up (spawned and not since taken). */
  isUp: boolean;
  /** Number taken so far, from the event feed. */
  takenCount: number;
  /** Who took the most recent one, when known. */
  lastTakenBy?: string;
  /** For dragons: the elemental type of the most recent kill. */
  lastSubtype?: string;
}

function lastEventOf(events: GameEventRecord[], kinds: string[]): GameEventRecord | undefined {
  let latest: GameEventRecord | undefined;
  for (const e of events) {
    if (!kinds.includes(e.kind)) continue;
    if (!latest || e.gameTime > latest.gameTime) latest = e;
  }
  return latest;
}

function countEventsOf(events: GameEventRecord[], kinds: string[]): number {
  return events.filter((e) => kinds.includes(e.kind)).length;
}

/**
 * Computes the next availability for one objective from its timing config plus
 * whatever the event feed has reported.
 */
function statusFor(
  id: ObjectiveId,
  label: string,
  timing: ObjectiveTiming,
  events: GameEventRecord[],
  eventKinds: string[],
  gameTime: number,
): ObjectiveStatus | null {
  if (!timing.enabled) return null;

  const last = lastEventOf(events, eventKinds);
  const takenCount = countEventsOf(events, eventKinds);

  let availableAt: number | null;
  if (!last) {
    availableAt = timing.firstSpawn;
  } else if (timing.respawn === null) {
    availableAt = null;
  } else {
    availableAt = last.gameTime + timing.respawn;
  }

  // A spawn cap retires the objective once it has been taken that many times.
  if (timing.maxSpawns !== null && takenCount >= timing.maxSpawns) {
    availableAt = null;
  }

  // Past its despawn window it is gone for good, even if a respawn would land.
  if (availableAt !== null && timing.despawn !== null && availableAt >= timing.despawn) {
    availableAt = null;
  }

  const isUp =
    availableAt !== null &&
    gameTime >= availableAt &&
    (timing.despawn === null || gameTime < timing.despawn);

  return {
    id,
    label,
    availableAt,
    isUp,
    takenCount,
    ...(last?.killer ? { lastTakenBy: last.killer } : {}),
    ...(last?.subtype ? { lastSubtype: last.subtype } : {}),
  };
}

export function objectiveStatuses(
  gameTime: number,
  events: GameEventRecord[],
  patch: PatchConfig = DEFAULT_PATCH,
): ObjectiveStatus[] {
  const specs: Array<[ObjectiveId, string, ObjectiveTiming, string[]]> = [
    ['dragon', 'Dragon', patch.dragon, ['DragonKill']],
    ['grubs', 'Void Grubs', patch.grubs, ['HordeKill']],
    ['herald', 'Rift Herald', patch.herald, ['HeraldKill']],
    ['baron', 'Baron Nashor', patch.baron, ['BaronKill']],
  ];

  return specs
    .map(([id, label, timing, kinds]) => statusFor(id, label, timing, events, kinds, gameTime))
    .filter((s): s is ObjectiveStatus => s !== null);
}

/**
 * Scuttle's first spawn is deterministic; respawns are not observable from the
 * API, so this only covers the opening one. After that the user starts a
 * manual timer.
 */
export function firstScuttleStatus(
  gameTime: number,
  patch: PatchConfig = DEFAULT_PATCH,
): ObjectiveStatus | null {
  if (!patch.scuttle.enabled) return null;
  return {
    id: 'scuttle',
    label: 'Scuttle Crab',
    availableAt: patch.scuttle.firstSpawn,
    isUp: gameTime >= patch.scuttle.firstSpawn,
    takenCount: 0,
  };
}

/** Dragon souls/types taken per team, for the draft-adjacent "who wins late" read. */
export function dragonsTakenBy(events: GameEventRecord[]): Map<string, string[]> {
  const byKiller = new Map<string, string[]>();
  for (const e of events) {
    if (e.kind !== 'DragonKill' || !e.killer) continue;
    const list = byKiller.get(e.killer) ?? [];
    list.push(e.subtype ?? 'Unknown');
    byKiller.set(e.killer, list);
  }
  return byKiller;
}
