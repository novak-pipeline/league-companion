import type { GameEventRecord } from './types.js';
import { DEFAULT_PATCH, type PatchConfig } from './patch.js';

/**
 * Neutral objective availability.
 *
 * First spawns come from the patch config; respawns are derived from the live
 * event feed (Riot reports dragon/herald/baron kills as events). Scuttle deaths
 * are *not* in the event feed, so scuttle respawns are handled as user-started
 * manual timers instead — see `ManualTimer` in types.ts.
 */

export type ObjectiveId = 'dragon' | 'grubs' | 'herald' | 'baron' | 'atakhan' | 'scuttle';

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
 * Computes the next availability for a respawning objective.
 *
 * `firstSpawn` applies until the first kill; afterwards it is
 * `lastKill + respawn`. A null `despawn` means it never expires.
 */
function respawningStatus(
  id: ObjectiveId,
  label: string,
  events: GameEventRecord[],
  eventKinds: string[],
  gameTime: number,
  firstSpawn: number | null,
  respawn: number | null,
  despawn: number | null,
): ObjectiveStatus {
  const last = lastEventOf(events, eventKinds);
  const takenCount = countEventsOf(events, eventKinds);

  let availableAt: number | null;
  if (!last) {
    availableAt = firstSpawn;
  } else if (respawn === null) {
    availableAt = null;
  } else {
    availableAt = last.gameTime + respawn;
  }

  // Past its despawn window (grubs and herald both expire) it is gone for good.
  if (availableAt !== null && despawn !== null && availableAt >= despawn) {
    availableAt = null;
  }

  const isUp = availableAt !== null && gameTime >= availableAt && (despawn === null || gameTime < despawn);

  return {
    id,
    label,
    availableAt,
    isUp,
    takenCount,
    lastTakenBy: last?.killer,
    lastSubtype: last?.subtype,
  };
}

export function objectiveStatuses(
  gameTime: number,
  events: GameEventRecord[],
  patch: PatchConfig = DEFAULT_PATCH,
): ObjectiveStatus[] {
  const statuses: ObjectiveStatus[] = [
    respawningStatus(
      'dragon',
      'Dragon',
      events,
      ['DragonKill'],
      gameTime,
      patch.dragonFirstSpawn,
      patch.dragonRespawn,
      null,
    ),
    respawningStatus(
      'grubs',
      'Void Grubs',
      events,
      ['HordeKill'],
      gameTime,
      patch.grubsFirstSpawn,
      // Grubs come in two sets; after the second they are gone. Treated as a
      // single respawn so the timer stops rather than looping forever.
      countEventsOf(events, ['HordeKill']) >= 2 ? null : patch.grubsFirstSpawn,
      patch.grubsDespawn,
    ),
    respawningStatus(
      'herald',
      'Rift Herald',
      events,
      ['HeraldKill'],
      gameTime,
      patch.heraldFirstSpawn,
      null,
      patch.heraldDespawn,
    ),
    respawningStatus(
      'baron',
      'Baron Nashor',
      events,
      ['BaronKill'],
      gameTime,
      patch.baronFirstSpawn,
      patch.baronRespawn,
      null,
    ),
  ];

  if (patch.atakhanFirstSpawn !== null) {
    statuses.push(
      respawningStatus(
        'atakhan',
        'Atakhan',
        events,
        ['AtakhanKill'],
        gameTime,
        patch.atakhanFirstSpawn,
        null,
        null,
      ),
    );
  }

  return statuses;
}

/**
 * Scuttle's first spawn is deterministic; respawns are not observable from the
 * API, so this only covers the opening one. After that the user starts a
 * manual timer.
 */
export function firstScuttleStatus(
  gameTime: number,
  patch: PatchConfig = DEFAULT_PATCH,
): ObjectiveStatus {
  return {
    id: 'scuttle',
    label: 'Scuttle Crab',
    availableAt: patch.scuttleFirstSpawn,
    isUp: gameTime >= patch.scuttleFirstSpawn,
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
