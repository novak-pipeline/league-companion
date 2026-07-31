import type { Cue, GameRecord, GameSnapshot, Lane } from './types.js';
import { DEFAULT_PATCH, type PatchConfig } from './patch.js';
import { nextCannonWave } from './waves.js';
import { firstScuttleStatus, objectiveStatuses } from './objectives.js';
import { findLaneOpponent } from './tracking/metrics.js';

/**
 * Derived mid-lane insight.
 *
 * This module exists because of a specific complaint: League already shows
 * objective timers on its own scoreboard, so an overlay that redraws them adds
 * nothing. Everything here is something the game does *not* tell you — either
 * because it is arithmetic a good player does in their head, or because it
 * needs history the client has never seen.
 *
 * The bar for anything in this file: if a player could read it off the game's
 * HUD, it does not belong here.
 */

export interface InsightContext {
  snapshot: GameSnapshot;
  lane: Lane;
  patch: PatchConfig;
  /**
   * Expected CS at a given game time, from the player's own recent games.
   * Null when there is not enough history to say anything honest.
   */
  csBaseline: ((gameTime: number) => number | null) | null;
}

/** How far ahead a jungle-clear or roam window is worth flagging. */
const LOOKAHEAD = 30;

function severityFor(eta: number | null): Cue['severity'] {
  if (eta === null) return 'now';
  if (eta <= 5) return 'urgent';
  if (eta <= 15) return 'now';
  if (eta <= 40) return 'soon';
  return 'idle';
}

/**
 * Builds a CS-pace baseline from stored games.
 *
 * Uses the timeline samples recorded per game, so the comparison is against
 * *your* actual curve rather than a generic benchmark — "behind your own pace"
 * is far more actionable than "behind some pro number". Returns null when there
 * are too few games for the average to mean anything.
 */
export function makeCsBaseline(
  history: GameRecord[],
  minGames = 5,
): ((gameTime: number) => number | null) | null {
  const withSamples = history.filter((g) => g.samples.length > 0);
  if (withSamples.length < minGames) return null;

  return (gameTime: number): number | null => {
    const values: number[] = [];
    for (const game of withSamples) {
      // The sample at or just before this point in that game.
      let best: number | null = null;
      for (const sample of game.samples) {
        if (sample.gameTime > gameTime) break;
        best = sample.cs;
      }
      // Only count games that actually reached this far.
      if (best !== null && game.durationSeconds >= gameTime) values.push(best);
    }
    if (values.length < minGames) return null;
    return Math.round(values.reduce((a, b) => a + b, 0) / values.length);
  };
}

/**
 * Enemy jungler pressure windows.
 *
 * The clear-completion times are arithmetic, not observation — the app never
 * claims to know where the jungler *is*, only when a standard clear would put
 * them in a position to show. Riot does not expose enemy positions and
 * inferring them would be well outside what their policy allows.
 */
function jungleCues(ctx: InsightContext): Cue[] {
  const { snapshot, patch } = ctx;
  const cues: Cue[] = [];

  const windows: Array<[string, number, string]> = [
    ['jungle-1', patch.jungleFirstClearDone, 'First clear done — gank window opens'],
    ['jungle-2', patch.jungleSecondClearDone, 'Second clear done — expect a play'],
  ];

  for (const [id, at, label] of windows) {
    const eta = at - snapshot.gameTime;
    // Show it approaching, and hold it briefly once live.
    if (eta > LOOKAHEAD || eta < -20) continue;
    cues.push({
      id,
      kind: 'jungle',
      label: eta <= 0 ? 'Jungler could be here' : 'Jungler clear',
      detail: label,
      etaSeconds: eta <= 0 ? null : eta,
      severity: eta <= 0 ? 'now' : severityFor(eta),
      sortKey: 12,
    });
  }

  return cues;
}

/**
 * Roam windows: a cannon wave you can shove, lining up with something worth
 * walking to. Neither half is a cue on its own — the value is the coincidence,
 * which is exactly the read a mid laner is supposed to make and the one that is
 * easiest to miss while last-hitting.
 */
function roamCues(ctx: InsightContext): Cue[] {
  const { snapshot, lane, patch } = ctx;
  const cannon = nextCannonWave(snapshot.gameTime, lane, patch);
  if (!cannon) return [];

  const cannonEta = cannon.arrivalTime - snapshot.gameTime;
  // Only interesting while the cannon wave is close enough to plan around.
  if (cannonEta > 40 || cannonEta < 0) return [];

  const targets: Array<{ label: string; at: number }> = [];

  const scuttle = firstScuttleStatus(snapshot.gameTime, patch);
  if (scuttle && !scuttle.isUp && scuttle.availableAt !== null) {
    targets.push({ label: 'scuttle', at: scuttle.availableAt });
  }
  for (const obj of objectiveStatuses(snapshot.gameTime, snapshot.events, patch)) {
    if (obj.availableAt !== null && obj.availableAt > snapshot.gameTime) {
      targets.push({ label: obj.label.toLowerCase(), at: obj.availableAt });
    }
  }

  // The window that matters: shove the cannon, then arrive as the thing spawns.
  const reachable = targets.filter((t) => {
    const gap = t.at - cannon.arrivalTime;
    return gap >= 0 && gap <= 45;
  });
  if (reachable.length === 0) return [];

  const soonest = reachable.reduce((a, b) => (a.at <= b.at ? a : b));
  return [
    {
      id: `roam-${cannon.index}`,
      kind: 'roam',
      label: 'Roam window',
      detail: `Shove cannon wave ${cannon.index}, then ${soonest.label}`,
      etaSeconds: cannonEta,
      severity: severityFor(cannonEta),
      lane,
      sortKey: 14,
    },
  ];
}

/**
 * Level spikes you can act on.
 *
 * Only emitted when the opponent crosses a breakpoint *before* you do — that is
 * the dangerous case and the one that gets missed. When you are ahead there is
 * nothing to warn about.
 */
function spikeCues(ctx: InsightContext): Cue[] {
  const { snapshot } = ctx;
  const self = snapshot.self;
  if (!self) return [];
  const opponent = findLaneOpponent(snapshot);
  if (!opponent) return [];

  const breakpoints = [6, 11, 16];
  for (const level of breakpoints) {
    if (opponent.level >= level && self.level < level) {
      return [
        {
          id: `spike-${level}`,
          kind: 'spike',
          label: `They hit ${level} first`,
          detail: 'Respect the all-in until you match it',
          etaSeconds: null,
          severity: 'now',
          sortKey: 16,
        },
      ];
    }
  }
  return [];
}

/**
 * CS pace against your own recent games.
 *
 * Deliberately quiet: only speaks when you are meaningfully behind your own
 * average, because a cue that fires when things are fine trains you to ignore
 * it. Never fires without enough history to be honest.
 */
function paceCues(ctx: InsightContext): Cue[] {
  const { snapshot, csBaseline } = ctx;
  const self = snapshot.self;
  if (!self || !csBaseline) return [];
  // Before the first few waves the numbers are too small to be meaningful.
  if (snapshot.gameTime < 240) return [];

  const expected = csBaseline(snapshot.gameTime);
  if (expected === null || expected <= 0) return [];

  const behind = expected - self.creepScore;
  if (behind < 8) return [];

  return [
    {
      id: 'pace-cs',
      kind: 'pace',
      label: `${behind} CS behind your pace`,
      detail: `${self.creepScore} now · you usually have ${expected} here`,
      etaSeconds: null,
      severity: behind >= 20 ? 'now' : 'soon',
      sortKey: 18,
    },
  ];
}

/** All derived insight cues for the current snapshot. */
export function buildInsightCues(ctx: Partial<InsightContext> & { snapshot: GameSnapshot }): Cue[] {
  const full: InsightContext = {
    lane: 'mid',
    patch: DEFAULT_PATCH,
    csBaseline: null,
    ...ctx,
  };

  return [...jungleCues(full), ...roamCues(full), ...spikeCues(full), ...paceCues(full)];
}
