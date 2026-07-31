import type { Lane } from './types.js';
import { DEFAULT_PATCH, stepValueAt, type PatchConfig } from './patch.js';

/**
 * Minion wave scheduling.
 *
 * Waves spawn on a fixed cadence from the game clock, so everything here is a
 * pure function of `gameTime` — no game state needed. That makes the most
 * useful mid-lane information available even when the live API is only giving
 * us a clock.
 */

export interface WaveInfo {
  /** 1-based wave number. */
  index: number;
  /** Game time (s) the wave leaves the spawn platform. */
  spawnTime: number;
  /** Game time (s) the wave reaches the lane's midpoint. */
  arrivalTime: number;
  hasCannon: boolean;
}

/**
 * How many waves to look ahead. 120 waves is ~62 minutes of game time, past
 * any realistic game length.
 */
const MAX_WAVES = 200;

/**
 * Builds the wave schedule for a lane.
 *
 * Two things here are stateful rather than arithmetic, and both are required
 * for correctness on the 2026 season:
 *
 *   - Spawn times **accumulate**. The interval steps down as the game goes on
 *     (waves come faster late), so `first + n * interval` is wrong the moment
 *     the game crosses a step boundary; each wave's time depends on the one
 *     before it.
 *   - The cannon counter tracks "waves since the last cannon" rather than a
 *     modulo on the wave index, because Riot continues counting across the
 *     cadence change instead of restarting on a fixed boundary.
 */
export function buildWaveSchedule(
  lane: Lane = 'mid',
  patch: PatchConfig = DEFAULT_PATCH,
  maxWaves: number = MAX_WAVES,
): WaveInfo[] {
  const waves: WaveInfo[] = [];
  const travel = patch.laneTravelSeconds[lane];
  let sinceCannon = 0;
  let spawnTime = patch.firstWaveSpawn;

  for (let index = 1; index <= maxWaves; index++) {
    sinceCannon += 1;
    const hasCannon = sinceCannon >= stepValueAt(patch.cannonEvery, spawnTime);
    if (hasCannon) sinceCannon = 0;

    waves.push({ index, spawnTime, arrivalTime: spawnTime + travel, hasCannon });

    // The next wave's interval is the one in effect when *this* wave spawned.
    spawnTime += stepValueAt(patch.waveIntervals, spawnTime);
  }

  return waves;
}

/** The next wave to *arrive* in lane at or after `gameTime`. */
export function nextWave(
  gameTime: number,
  lane: Lane = 'mid',
  patch: PatchConfig = DEFAULT_PATCH,
): WaveInfo | null {
  const schedule = buildWaveSchedule(lane, patch);
  return schedule.find((w) => w.arrivalTime >= gameTime) ?? null;
}

/** The next wave containing a cannon minion, by arrival time. */
export function nextCannonWave(
  gameTime: number,
  lane: Lane = 'mid',
  patch: PatchConfig = DEFAULT_PATCH,
): WaveInfo | null {
  const schedule = buildWaveSchedule(lane, patch);
  return schedule.find((w) => w.hasCannon && w.arrivalTime >= gameTime) ?? null;
}

/** All waves arriving within the next `horizon` seconds. */
export function upcomingWaves(
  gameTime: number,
  horizon: number,
  lane: Lane = 'mid',
  patch: PatchConfig = DEFAULT_PATCH,
): WaveInfo[] {
  return buildWaveSchedule(lane, patch).filter(
    (w) => w.arrivalTime >= gameTime && w.arrivalTime <= gameTime + horizon,
  );
}

export interface BackWindow {
  /** The cannon wave this advice is anchored to. */
  cannonWave: WaveInfo;
  /**
   * Game time at which leaving lane costs the least: after the cannon wave has
   * been shoved in, which is roughly when the *next* wave arrives.
   */
  opensAt: number;
  /** When the following wave reaches your tower and starts costing you CS. */
  closesAt: number;
  /** Round-trip cost (recall + walk back) for the lane. */
  roundTripSeconds: number;
}

/**
 * The standard mid-lane back heuristic: shove the cannon wave into their
 * tower, then recall. You lose the least gold that way and return before the
 * following wave has bounced back to you.
 *
 * Returns the window anchored to the next cannon wave.
 */
export function nextBackWindow(
  gameTime: number,
  lane: Lane = 'mid',
  patch: PatchConfig = DEFAULT_PATCH,
): BackWindow | null {
  const schedule = buildWaveSchedule(lane, patch);

  // The window opens *after* its cannon wave arrives, so anchoring to the next
  // upcoming cannon would hide the window the player is currently standing in.
  // Instead take the earliest cannon whose window has not closed yet.
  for (const cannon of schedule) {
    if (!cannon.hasCannon) continue;

    const following = schedule.find((w) => w.index === cannon.index + 1);
    if (!following) continue;
    const afterThat = schedule.find((w) => w.index === cannon.index + 2);

    // Shoving a cannon wave under tower takes roughly until the next wave lands.
    const opensAt = following.arrivalTime;
    const closesAt =
      afterThat?.arrivalTime ??
      following.arrivalTime + stepValueAt(patch.waveIntervals, following.spawnTime);
    if (closesAt <= gameTime) continue;

    return {
      cannonWave: cannon,
      opensAt,
      closesAt,
      roundTripSeconds: patch.recallSeconds + patch.walkBackSeconds[lane],
    };
  }

  return null;
}
