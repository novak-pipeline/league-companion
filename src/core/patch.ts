/**
 * Patch-dependent timing constants.
 *
 * Riot changes these often, and the 2026 season changed them structurally: wave
 * spawn intervals now step down as the game goes on, Atakhan was removed
 * entirely, and Baron moved back to 20 minutes. Everything the timer engine
 * needs lives here so a patch update is a one-file edit, and the UI shows which
 * config is loaded rather than quietly being wrong.
 *
 * VERIFY AGAINST CURRENT PATCH NOTES before trusting these in a ranked game.
 * `label` is displayed in the companion's settings panel for exactly that
 * reason — a stale number here is worse than no number at all.
 */

/** A spawn interval that applies from `fromGameTime` until the next step. */
export interface IntervalStep {
  /** Game time (s) this interval starts applying. */
  fromGameTime: number;
  seconds: number;
}

export interface ObjectiveTiming {
  /** False when the objective does not exist on this patch. */
  enabled: boolean;
  firstSpawn: number;
  /** Null when it never comes back. */
  respawn: number | null;
  /** Game time it stops being available; null when it never expires. */
  despawn: number | null;
  /** Hard cap on how many times it can spawn; null for unlimited. */
  maxSpawns: number | null;
}

/**
 * Values in this config that could not be confirmed against Riot's own patch
 * notes, with what is uncertain about each.
 *
 * This list is surfaced in the UI rather than kept as a code comment, because a
 * countdown that looks authoritative and is quietly eight seconds wrong is
 * worse than one labelled as an estimate. Anything here should be checked
 * in-client before being trusted in a ranked game.
 */
export interface PatchCaveat {
  field: string;
  note: string;
}

export interface PatchConfig {
  label: string;

  /** Game time (s) the first minion wave leaves the spawn platform. */
  firstWaveSpawn: number;
  /**
   * Wave spawn cadence, as steps. Must be sorted by `fromGameTime` ascending
   * and start at 0. The 2026 season made this variable — waves come faster
   * later in the game — so a single interval no longer models it.
   */
  waveIntervals: IntervalStep[];
  /**
   * Cannon (siege) minion cadence: a cannon rides every Nth wave, stepped the
   * same way. Expressed as "one cannon per this many waves".
   */
  cannonEvery: IntervalStep[];
  /** Seconds for a freshly spawned wave to reach the lane's midpoint. */
  laneTravelSeconds: Record<'top' | 'mid' | 'bot', number>;

  scuttle: ObjectiveTiming;
  dragon: ObjectiveTiming;
  grubs: ObjectiveTiming;
  herald: ObjectiveTiming;
  baron: ObjectiveTiming;

  /** Recall channel time (s). */
  recallSeconds: number;
  /** Rough walk time from fountain back to lane, per lane. */
  walkBackSeconds: Record<'top' | 'mid' | 'bot', number>;

  /**
   * Roughly when an enemy jungler starting on either side finishes a standard
   * clear and can show up in lane. Not exposed by any API — it is arithmetic a
   * good player does in their head, which is exactly the kind of thing worth
   * surfacing.
   */
  jungleFirstClearDone: number;
  jungleSecondClearDone: number;

  /** Values that could not be verified; shown to the user, not hidden. */
  caveats: PatchCaveat[];
}

/**
 * 2026 season (Season 16) defaults.
 *
 * Sourced from patch 26.1 notes and community trackers; see README for the
 * verification note. Known 2026 changes reflected here:
 *   - Atakhan and Feats of Strength removed (patch 26.1).
 *   - Baron back to 20:00.
 *   - Void Grubs reduced to a single set.
 *   - Minions spawn earlier, move faster, and spawn more often, with the
 *     interval stepping down at 14:00 and 30:00.
 */
export const DEFAULT_PATCH: PatchConfig = {
  label: 'Season 2026 (26.x) — some values unverified, see caveats',

  // Confirmed: 26.1 moved the first wave from 1:05 to 0:30.
  firstWaveSpawn: 30,
  // Confirmed: 30s base, stepping to 25s at 14:00 and 20s at 30:00.
  waveIntervals: [
    { fromGameTime: 0, seconds: 30 },
    { fromGameTime: 14 * 60, seconds: 25 },
    { fromGameTime: 30 * 60, seconds: 20 },
  ],
  // The first cannon riding wave 3 is corroborated arithmetically: 0:30 + 2x30s
  // = 1:30, which matches the reported "first siege wave at 1:30". The later
  // transitions are NOT confirmed — see caveats.
  cannonEvery: [
    { fromGameTime: 0, seconds: 3 },
    { fromGameTime: 15 * 60, seconds: 2 },
    { fromGameTime: 25 * 60, seconds: 1 },
  ],
  // 26.1 raised minion move speed (325 -> 350 base), so travel is shorter than
  // the long-standing ~22s mid figure. These are scaled estimates, not sourced
  // numbers — the single most important thing to calibrate in-client.
  laneTravelSeconds: { top: 30, mid: 21, bot: 30 },

  scuttle: { enabled: true, firstSpawn: 3 * 60 + 30, respawn: 2 * 60 + 30, despawn: null, maxSpawns: null },
  dragon: { enabled: true, firstSpawn: 5 * 60, respawn: 5 * 60, despawn: null, maxSpawns: null },
  // A single set of 3, spawning at 8:00. The second set was removed in 25.09
  // (not 26.1), and the spawn moved 6:00 -> 8:00 in the same patch.
  grubs: { enabled: true, firstSpawn: 8 * 60, respawn: null, despawn: 14 * 60 + 45, maxSpawns: 1 },
  // Herald occupies the Baron pit, so its despawn tracks Baron's spawn. With
  // Baron back at 20:00 the old 24:45 despawn is impossible; 19:45 is the only
  // consistent value.
  herald: { enabled: true, firstSpawn: 15 * 60, respawn: null, despawn: 19 * 60 + 45, maxSpawns: 1 },
  baron: { enabled: true, firstSpawn: 20 * 60, respawn: 6 * 60, despawn: null, maxSpawns: null },

  recallSeconds: 8,
  walkBackSeconds: { top: 15, mid: 11, bot: 15 },

  jungleFirstClearDone: 3 * 60 + 15,
  jungleSecondClearDone: 6 * 60 + 30,

  caveats: [
    {
      field: 'laneTravelSeconds',
      note: 'Estimated from the 26.1 move-speed increase, not a published figure. Calibrate with the wave-arrival offset after watching one game.',
    },
    {
      field: 'cannonEvery',
      note: 'The every-2nd-wave transition is either 14:00 or 15:00 — sources conflict. Cannon countdowns after 14:00 may be one wave out.',
    },
    {
      field: 'herald.firstSpawn',
      note: 'Reported as 15:00 following a 25.09 change, but not confirmed against a current-patch source.',
    },
    {
      field: 'grubs.despawn',
      note: 'Sources give 13:45 and 14:45; 14:45 fits a 15:00 Herald and is used here.',
    },
    {
      field: 'jungleFirstClearDone',
      note: 'A standard clear estimate, not a game rule. Jungle camps reportedly moved to 0:55, which would shift this.',
    },
  ],
};

/** The interval in effect at `gameTime` for a stepped schedule. */
export function stepValueAt(steps: IntervalStep[], gameTime: number): number {
  let value = steps[0]?.seconds ?? 30;
  for (const step of steps) {
    if (gameTime >= step.fromGameTime) value = step.seconds;
    else break;
  }
  return value;
}
