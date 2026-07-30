import type { ChampionData, CompAnalysis, CompFlag } from '../types.js';

/**
 * Team composition analysis.
 *
 * IMPORTANT: this deliberately does not produce a win probability. A real one
 * needs millions of scraped games; anything computed from a static table would
 * be a made-up number wearing a percent sign. What this does instead is score
 * how *functional* a comp is — whether it has the pieces a team needs — and
 * surface concrete gaps the player can act on during draft.
 */

/** Weights for the overall functionality score. Tuned to feel right, not fitted. */
const WEIGHTS = {
  damageBalance: 22,
  frontline: 20,
  engage: 18,
  peel: 14,
  cc: 14,
  waveclear: 12,
} as const;

function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

/** Frontline credit: tanks are worth most, then melee fighters. */
function frontlineValue(champ: ChampionData): number {
  if (champ.classes.includes('tank')) return 3;
  if (champ.classes.includes('fighter') && champ.range === 'melee') return 2;
  if (champ.range === 'melee') return 1;
  return 0;
}

/**
 * Damage split, weighted so a "mixed" champion contributes to both sides.
 * Returned as percentages of total damage output.
 */
export function damageMix(champs: ChampionData[]): { physical: number; magic: number } {
  if (champs.length === 0) return { physical: 0, magic: 0 };
  let physical = 0;
  let magic = 0;
  for (const c of champs) {
    if (c.damage === 'physical') physical += 1;
    else if (c.damage === 'magic') magic += 1;
    else {
      physical += 0.5;
      magic += 0.5;
    }
  }
  const total = physical + magic;
  return {
    physical: Math.round((physical / total) * 100),
    magic: Math.round((magic / total) * 100),
  };
}

/** Counts of champions by when they come online. */
export function scalingSpread(champs: ChampionData[]): { early: number; mid: number; late: number } {
  return {
    early: champs.filter((c) => c.scaling === 'early').length,
    mid: champs.filter((c) => c.scaling === 'mid').length,
    late: champs.filter((c) => c.scaling === 'late').length,
  };
}

/**
 * Scores a (possibly incomplete) comp.
 *
 * Sub-scores are normalized against a full five-player team, so a 3-pick comp
 * reads as genuinely incomplete rather than being flattered by averaging.
 */
export function analyzeComp(champs: ChampionData[]): CompAnalysis {
  const mix = damageMix(champs);
  const scaling = scalingSpread(champs);
  const flags: CompFlag[] = [];

  const frontline = sum(champs.map(frontlineValue));
  const engage = sum(champs.map((c) => c.engage));
  const peel = sum(champs.map((c) => c.peel));
  const cc = sum(champs.map((c) => c.cc));
  const waveclear = sum(champs.map((c) => c.waveclear));

  // Reference totals a healthy five-man comp tends to hit.
  const norm = (value: number, healthy: number) => Math.min(1, value / healthy);

  // Damage balance peaks at an even split and falls off toward either extreme.
  const balance = champs.length === 0 ? 0 : 1 - Math.abs(mix.physical - 50) / 50;

  const score = Math.round(
    WEIGHTS.damageBalance * balance +
      WEIGHTS.frontline * norm(frontline, 6) +
      WEIGHTS.engage * norm(engage, 5) +
      WEIGHTS.peel * norm(peel, 4) +
      WEIGHTS.cc * norm(cc, 7) +
      WEIGHTS.waveclear * norm(waveclear, 8),
  );

  // --- Flags: the actionable part -----------------------------------------
  if (champs.length >= 3) {
    if (mix.physical >= 80) {
      flags.push({
        severity: mix.physical >= 90 ? 'critical' : 'warn',
        message: `${mix.physical}% physical damage — one armour item blunts the whole comp`,
      });
    }
    if (mix.magic >= 80) {
      flags.push({
        severity: mix.magic >= 90 ? 'critical' : 'warn',
        message: `${mix.magic}% magic damage — they can itemize magic resist and stall`,
      });
    }
    if (frontline === 0) {
      flags.push({ severity: 'critical', message: 'No frontline — nobody can hold a fight' });
    } else if (frontline <= 2) {
      flags.push({ severity: 'warn', message: 'Very little frontline' });
    }
    if (engage === 0) {
      flags.push({
        severity: 'warn',
        message: 'No hard engage — you will struggle to force fights or close a game out',
      });
    }
    if (cc <= 2) {
      flags.push({ severity: 'warn', message: 'Low crowd control' });
    }
  }

  if (champs.length === 5) {
    if (peel === 0) {
      flags.push({ severity: 'warn', message: 'No peel — your carry is on their own' });
    }
    if (waveclear <= 3) {
      flags.push({
        severity: 'info',
        message: 'Weak waveclear — sieges and lane pressure will be a problem',
      });
    }
    if (scaling.late >= 3) {
      flags.push({ severity: 'info', message: 'Late-game comp — play safe and scale' });
    }
    if (scaling.early >= 3) {
      flags.push({ severity: 'info', message: 'Early-game comp — force tempo before 20 min' });
    }
  }

  return {
    damageMix: mix,
    frontline,
    engage,
    peel,
    waveclear,
    cc,
    scaling,
    score: Math.max(0, Math.min(100, score)),
    flags,
  };
}

/** Human-readable comparisons between two comps, for the draft panel. */
export function compareComps(ally: CompAnalysis, enemy: CompAnalysis): string[] {
  const edges: string[] = [];

  const lateEdge = ally.scaling.late - enemy.scaling.late;
  const earlyEdge = ally.scaling.early - enemy.scaling.early;
  if (lateEdge >= 2) edges.push('You scale harder — trade early tempo for time');
  else if (lateEdge <= -2) edges.push('They scale harder — you need to win before 25 min');
  if (earlyEdge >= 2) edges.push('You are stronger early — look for tempo and objectives');
  else if (earlyEdge <= -2) edges.push('They are stronger early — respect the first 15 min');

  if (ally.engage - enemy.engage >= 3) edges.push('You have far more engage — you pick the fights');
  else if (enemy.engage - ally.engage >= 3) edges.push('They out-engage you — ward flanks and hold peel');

  if (ally.frontline - enemy.frontline >= 3) edges.push('You have the tankier front line');
  else if (enemy.frontline - ally.frontline >= 3) edges.push('They are much tankier — bring percent-health damage');

  if (enemy.damageMix.physical >= 75) edges.push(`They are ${enemy.damageMix.physical}% AD — armour is very efficient`);
  if (enemy.damageMix.magic >= 75) edges.push(`They are ${enemy.damageMix.magic}% AP — magic resist is very efficient`);

  if (ally.cc - enemy.cc >= 4) edges.push('You have much more CC — extended fights favour you');
  else if (enemy.cc - ally.cc >= 4) edges.push('They have much more CC — buy tenacity/cleanse and spread out');

  return edges;
}
