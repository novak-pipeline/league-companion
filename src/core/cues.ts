import type { Cue, CueSeverity, GameSnapshot, Lane, ManualTimer } from './types.js';
import { DEFAULT_PATCH, type PatchConfig } from './patch.js';
import { nextBackWindow, nextCannonWave, nextWave } from './waves.js';
import { firstScuttleStatus, objectiveStatuses } from './objectives.js';

/**
 * The cue engine.
 *
 * Takes a game snapshot plus any user-started manual timers and produces the
 * flat, sorted list the overlay draws. Pure and deterministic: same snapshot in,
 * same cues out. The overlay contains no timing logic of its own.
 */

export interface CueOptions {
  lane: Lane;
  patch: PatchConfig;
  /** Cues further out than this are dropped entirely. */
  horizonSeconds: number;
  /** Kinds the user has switched off in settings. */
  mutedKinds: string[];
}

export const DEFAULT_CUE_OPTIONS: CueOptions = {
  lane: 'mid',
  patch: DEFAULT_PATCH,
  horizonSeconds: 75,
  mutedKinds: [],
};

/**
 * Severity ramps as the event approaches. `urgent` is reserved for the last
 * few seconds, where the player needs to already be moving.
 */
function severityFor(eta: number | null): CueSeverity {
  if (eta === null) return 'now';
  if (eta <= 5) return 'urgent';
  if (eta <= 15) return 'now';
  if (eta <= 40) return 'soon';
  return 'idle';
}

function fmt(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}:${String(rem).padStart(2, '0')}`;
}

export function buildCues(
  snapshot: GameSnapshot,
  manualTimers: ManualTimer[] = [],
  options: Partial<CueOptions> = {},
): Cue[] {
  const opts: CueOptions = { ...DEFAULT_CUE_OPTIONS, ...options };
  const { gameTime } = snapshot;
  const { lane, patch, horizonSeconds } = opts;
  const cues: Cue[] = [];

  // --- Waves ---------------------------------------------------------------
  const cannon = nextCannonWave(gameTime, lane, patch);
  if (cannon) {
    const eta = cannon.arrivalTime - gameTime;
    if (eta <= horizonSeconds) {
      cues.push({
        id: `cannon-${cannon.index}`,
        kind: 'cannon',
        label: 'Cannon wave',
        detail: `Wave ${cannon.index} · arrives ${fmt(cannon.arrivalTime)}`,
        etaSeconds: eta,
        severity: severityFor(eta),
        lane,
        sortKey: 10,
      });
    }
  }

  const wave = nextWave(gameTime, lane, patch);
  if (wave && !wave.hasCannon) {
    const eta = wave.arrivalTime - gameTime;
    if (eta <= Math.min(horizonSeconds, 30)) {
      cues.push({
        id: `wave-${wave.index}`,
        kind: 'wave',
        label: `Wave ${wave.index}`,
        detail: 'Next wave arriving',
        etaSeconds: eta,
        severity: severityFor(eta),
        lane,
        sortKey: 20,
      });
    }
  }

  // --- Back window ---------------------------------------------------------
  const back = nextBackWindow(gameTime, lane, patch);
  if (back) {
    const opensIn = back.opensAt - gameTime;
    const closesIn = back.closesAt - gameTime;
    // Only show it once the anchoring cannon wave is actually near.
    if (opensIn <= horizonSeconds && closesIn > 0) {
      const live = opensIn <= 0;
      cues.push({
        id: `back-${back.cannonWave.index}`,
        kind: 'back',
        label: live ? 'Back window OPEN' : 'Back window',
        detail: live
          ? `Closes in ${fmt(closesIn)} · round trip ~${back.roundTripSeconds}s`
          : `Shove cannon wave ${back.cannonWave.index}, then recall`,
        etaSeconds: live ? null : opensIn,
        severity: live ? 'now' : severityFor(opensIn),
        lane,
        sortKey: 30,
      });
    }
  }

  // --- First scuttle -------------------------------------------------------
  const scuttle = firstScuttleStatus(gameTime, patch);
  if (!scuttle.isUp && scuttle.availableAt !== null) {
    const eta = scuttle.availableAt - gameTime;
    if (eta <= horizonSeconds) {
      cues.push({
        id: 'scuttle-first',
        kind: 'scuttle',
        label: 'Scuttle spawns',
        detail: 'Get prio and look to contest river',
        etaSeconds: eta,
        severity: severityFor(eta),
        sortKey: 40,
      });
    }
  }

  // --- Neutral objectives --------------------------------------------------
  for (const obj of objectiveStatuses(gameTime, snapshot.events, patch)) {
    if (obj.availableAt === null) continue;
    const eta = obj.availableAt - gameTime;
    if (eta > horizonSeconds) continue;

    const live = eta <= 0;
    const kind =
      obj.id === 'dragon'
        ? 'dragon'
        : obj.id === 'herald'
          ? 'herald'
          : obj.id === 'grubs'
            ? 'grubs'
            : obj.id === 'baron'
              ? 'baron'
              : 'atakhan';

    cues.push({
      id: `obj-${obj.id}-${obj.takenCount}`,
      kind,
      label: live ? `${obj.label} UP` : obj.label,
      detail: live ? 'Get vision and prio' : `Spawns ${fmt(obj.availableAt)}`,
      etaSeconds: live ? null : eta,
      severity: live ? 'now' : severityFor(eta),
      sortKey: 50,
    });
  }

  // --- Manual timers -------------------------------------------------------
  for (const timer of manualTimers) {
    const endsAt = timer.startedAtGameTime + timer.durationSeconds;
    const eta = endsAt - gameTime;
    if (eta < 0) continue;
    cues.push({
      id: `manual-${timer.id}`,
      kind: 'manual',
      label: timer.label,
      detail: `Started ${fmt(timer.startedAtGameTime)}`,
      etaSeconds: eta,
      severity: severityFor(eta),
      lane: timer.lane,
      sortKey: 60,
    });
  }

  return cues
    .filter((c) => !opts.mutedKinds.includes(c.kind))
    .sort((a, b) => {
      // Live cues float to the top, then by urgency, then by declared order.
      const aLive = a.etaSeconds === null ? 0 : 1;
      const bLive = b.etaSeconds === null ? 0 : 1;
      if (aLive !== bLive) return aLive - bLive;
      if (a.etaSeconds !== null && b.etaSeconds !== null && a.etaSeconds !== b.etaSeconds) {
        return a.etaSeconds - b.etaSeconds;
      }
      return a.sortKey - b.sortKey;
    });
}

/**
 * How much the overlay is allowed to say at once.
 *
 * The overlay competes with the game for attention, and a wall of countdowns is
 * worse than nothing — the player stops reading it. Density is the dial:
 * `minimal` shows one thing to act on, `full` is for the second monitor where
 * there is room to think.
 */
export type OverlayDensity = 'minimal' | 'normal' | 'full';

/** How many cues each density level will show. */
const DENSITY_LIMITS: Record<OverlayDensity, number> = {
  minimal: 1,
  normal: 3,
  full: Number.POSITIVE_INFINITY,
};

/**
 * Trims a cue list down to what a player can absorb mid-game.
 *
 * Idle cues — things far enough out that there is nothing to do yet — are
 * dropped below `full`, because the whole point is that a visible cue means
 * "act now", not "here is a clock". Live cues are never dropped: they are the
 * only ones that are actionable this instant.
 */
export function applyDensity(cues: Cue[], density: OverlayDensity): Cue[] {
  if (density === 'full') return cues;

  const actionable = cues.filter((c) => c.severity !== 'idle');
  const limit = DENSITY_LIMITS[density];

  // A live cue outranks any countdown, so keep those even past the limit.
  const live = actionable.filter((c) => c.etaSeconds === null);
  const pending = actionable.filter((c) => c.etaSeconds !== null);

  return [...live, ...pending].slice(0, Math.max(limit, live.length));
}

export { fmt as formatClock };
