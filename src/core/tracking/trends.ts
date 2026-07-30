import type { GameRecord, MetricSummary, TrendReport } from '../types.js';
import { kda } from './metrics.js';

/**
 * Trend analysis across stored games.
 *
 * The point is to answer "what should I practise?", so every metric carries a
 * target and the report ranks focus areas by how far short of target they fall.
 * Targets are solo-queue-improvement benchmarks, not pro numbers.
 */

export interface TrendTargets {
  csPerMin: number;
  csAt10: number;
  deathsPerGame: number;
  deathsBefore10: number;
  kda: number;
  visionPerMin: number;
}

/** Reasonable "you are climbing" benchmarks for a solo-queue mid laner. */
export const DEFAULT_TARGETS: TrendTargets = {
  csPerMin: 7.5,
  csAt10: 75,
  deathsPerGame: 4,
  deathsBefore10: 1,
  kda: 3,
  visionPerMin: 0.6,
};

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function round(value: number, places = 1): number {
  return Number(value.toFixed(places));
}

/**
 * Change between the older and newer halves of the window.
 * Null when there are too few games for the comparison to mean anything.
 */
function trendOf(games: GameRecord[], extract: (g: GameRecord) => number | null): number | null {
  const values = games.map(extract).filter((v): v is number => v !== null);
  if (values.length < 6) return null;
  const half = Math.floor(values.length / 2);
  // `games` is newest-first, so the first half is the recent one.
  const recent = mean(values.slice(0, half));
  const older = mean(values.slice(half));
  return round(recent - older, 2);
}

export function analyzeTrends(
  history: GameRecord[],
  windowSize = 20,
  targets: TrendTargets = DEFAULT_TARGETS,
): TrendReport {
  // Newest first.
  const games = [...history]
    .sort((a, b) => b.endedAt.localeCompare(a.endedAt))
    .slice(0, windowSize);

  if (games.length === 0) {
    return { gamesAnalyzed: 0, metrics: [], focusAreas: [], championBreakdown: [] };
  }

  const csPerMinValues = games.map((g) => g.csPerMin);
  const csAt10Values = games.map((g) => g.csAt10).filter((v): v is number => v !== null);
  const csDiffValues = games.map((g) => g.csDiffAt10).filter((v): v is number => v !== null);

  const metrics: MetricSummary[] = [
    {
      label: 'CS per minute',
      value: round(mean(csPerMinValues)),
      target: targets.csPerMin,
      higherIsBetter: true,
      unit: '',
      trend: trendOf(games, (g) => g.csPerMin),
    },
    {
      label: 'CS at 10 min',
      value: round(mean(csAt10Values)),
      target: targets.csAt10,
      higherIsBetter: true,
      unit: '',
      trend: trendOf(games, (g) => g.csAt10),
    },
    {
      label: 'Deaths per game',
      value: round(mean(games.map((g) => g.deaths))),
      target: targets.deathsPerGame,
      higherIsBetter: false,
      unit: '',
      trend: trendOf(games, (g) => g.deaths),
    },
    {
      label: 'Deaths before 10 min',
      value: round(mean(games.map((g) => g.deathsBefore10)), 2),
      target: targets.deathsBefore10,
      higherIsBetter: false,
      unit: '',
      trend: trendOf(games, (g) => g.deathsBefore10),
    },
    {
      label: 'KDA',
      value: round(mean(games.map((g) => kda(g))), 2),
      target: targets.kda,
      higherIsBetter: true,
      unit: '',
      trend: trendOf(games, (g) => kda(g)),
    },
  ];

  if (csDiffValues.length > 0) {
    metrics.push({
      label: 'CS diff at 10 min',
      value: round(mean(csDiffValues)),
      target: 0,
      higherIsBetter: true,
      unit: '',
      trend: trendOf(games, (g) => g.csDiffAt10),
    });
  }

  // Rank by how far short of target each metric falls, worst first.
  const shortfalls = metrics
    .map((m) => {
      const gap = m.higherIsBetter ? m.target - m.value : m.value - m.target;
      // Normalize so metrics on different scales compare fairly.
      const denominator = Math.abs(m.target) || 1;
      return { metric: m, gap, relative: gap / denominator };
    })
    .filter((s) => s.gap > 0)
    .sort((a, b) => b.relative - a.relative);

  const focusAreas = shortfalls.slice(0, 3).map(({ metric, gap }) => {
    const direction = metric.higherIsBetter ? 'below' : 'above';
    return `${metric.label}: ${metric.value} is ${round(gap, 2)} ${direction} the ${metric.target} target`;
  });

  // --- Per-champion breakdown ---------------------------------------------
  const byChampion = new Map<string, GameRecord[]>();
  for (const g of games) {
    const list = byChampion.get(g.champion) ?? [];
    list.push(g);
    byChampion.set(g.champion, list);
  }

  const championBreakdown = [...byChampion.entries()]
    .map(([champion, list]) => {
      const decided = list.filter((g) => g.win !== null);
      const wins = decided.filter((g) => g.win === true).length;
      return {
        champion,
        games: list.length,
        wins,
        winRate: decided.length === 0 ? 0 : Math.round((wins / decided.length) * 100),
        avgKda: round(mean(list.map((g) => kda(g))), 2),
        avgCsPerMin: round(mean(list.map((g) => g.csPerMin))),
      };
    })
    .sort((a, b) => b.games - a.games);

  return { gamesAnalyzed: games.length, metrics, focusAreas, championBreakdown };
}
