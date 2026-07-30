import { describe, expect, it } from 'vitest';
import { GameTracker, findLaneOpponent, kda } from '../src/core/tracking/metrics.js';
import { analyzeTrends } from '../src/core/tracking/trends.js';
import type { GameRecord, GameSnapshot, PlayerState } from '../src/core/types.js';

function player(overrides: Partial<PlayerState> = {}): PlayerState {
  return {
    summonerName: 'Me',
    championName: 'Ahri',
    team: 'ORDER',
    level: 6,
    isDead: false,
    respawnTimer: 0,
    kills: 0,
    deaths: 0,
    assists: 0,
    creepScore: 0,
    wardScore: 0,
    items: [],
    ...overrides,
  };
}

function snapshot(gameTime: number, self: PlayerState, others: PlayerState[] = []): GameSnapshot {
  return {
    gameTime,
    gameMode: 'CLASSIC',
    mapName: "Summoner's Rift",
    self,
    selfTeam: self.team,
    players: [self, ...others],
    events: [],
  };
}

describe('lane opponent', () => {
  it('matches the enemy in the same assigned position', () => {
    const me = player({ position: 'mid' });
    const enemy = player({ summonerName: 'Them', championName: 'Zed', team: 'CHAOS', position: 'mid' });
    expect(findLaneOpponent(snapshot(300, me, [enemy]))?.championName).toBe('Zed');
  });

  it('gives up rather than guessing when positions are unavailable', () => {
    const me = player();
    const enemy = player({ summonerName: 'Them', team: 'CHAOS' });
    expect(findLaneOpponent(snapshot(300, me, [enemy]))).toBeNull();
  });
});

describe('game tracker', () => {
  it('samples at the configured interval, not every poll', () => {
    const tracker = new GameTracker();
    for (let t = 0; t <= 60; t += 1) {
      tracker.observe(snapshot(t, player({ creepScore: t })));
    }
    // 15s interval over 60s gives about five samples, not sixty.
    expect(tracker.getSamples().length).toBeLessThan(8);
    expect(tracker.getSamples().length).toBeGreaterThan(2);
  });

  it('counts deaths before 10 minutes only', () => {
    const tracker = new GameTracker();
    tracker.observe(snapshot(300, player({ deaths: 0 })));
    tracker.observe(snapshot(400, player({ deaths: 2 })));
    tracker.observe(snapshot(900, player({ deaths: 5 })));
    const record = tracker.finalize(true)!;
    expect(record.deathsBefore10).toBe(2);
    expect(record.deaths).toBe(5);
  });

  it('captures the CS at 10 minutes benchmark', () => {
    const tracker = new GameTracker();
    for (let t = 0; t <= 700; t += 15) {
      tracker.observe(snapshot(t, player({ creepScore: Math.floor((t / 60) * 7) })));
    }
    const record = tracker.finalize(true)!;
    expect(record.csAt10).toBeGreaterThan(60);
    expect(record.csAt10).toBeLessThan(80);
  });

  it('leaves benchmarks null when the game ended first', () => {
    const tracker = new GameTracker();
    for (let t = 0; t <= 300; t += 15) {
      tracker.observe(snapshot(t, player({ creepScore: t })));
    }
    const record = tracker.finalize(false)!;
    expect(record.csAt10).toBeNull();
    expect(record.csAt15).toBeNull();
  });

  it('computes CS per minute', () => {
    const tracker = new GameTracker();
    tracker.observe(snapshot(600, player({ creepScore: 70 })));
    expect(tracker.finalize(true)!.csPerMin).toBe(7);
  });

  it('records an unknown result as null rather than a loss', () => {
    const tracker = new GameTracker();
    tracker.observe(snapshot(600, player({ creepScore: 70 })));
    expect(tracker.finalize(null)!.win).toBeNull();
  });

  it('returns null when it never saw the local player', () => {
    expect(new GameTracker().finalize(true)).toBeNull();
  });
});

describe('kda', () => {
  it('treats a deathless game as a single death', () => {
    expect(kda({ kills: 5, deaths: 0, assists: 5 })).toBe(10);
  });

  it('computes the usual ratio', () => {
    expect(kda({ kills: 6, deaths: 4, assists: 6 })).toBe(3);
  });
});

describe('trend analysis', () => {
  function game(overrides: Partial<GameRecord> = {}): GameRecord {
    return {
      id: Math.random().toString(36),
      startedAt: '2026-07-01T00:00:00Z',
      endedAt: '2026-07-01T00:30:00Z',
      gameMode: 'CLASSIC',
      champion: 'Ahri',
      win: true,
      durationSeconds: 1800,
      kills: 6, deaths: 4, assists: 6,
      cs: 210, csPerMin: 7,
      csAt10: 70, csAt15: 110, csDiffAt10: 0,
      deathsBefore10: 1,
      laneOpponent: 'Zed',
      samples: [],
      ...overrides,
    };
  }

  it('reports an empty state for no games', () => {
    const report = analyzeTrends([]);
    expect(report.gamesAnalyzed).toBe(0);
    expect(report.metrics).toEqual([]);
    expect(report.focusAreas).toEqual([]);
  });

  it('averages metrics across the window', () => {
    const report = analyzeTrends([game({ csPerMin: 6 }), game({ csPerMin: 8 })]);
    expect(report.metrics.find((m) => m.label === 'CS per minute')?.value).toBe(7);
  });

  it('respects the window size', () => {
    const games = Array.from({ length: 40 }, (_, i) =>
      game({ endedAt: `2026-07-${String((i % 28) + 1).padStart(2, '0')}T00:00:00Z` }),
    );
    expect(analyzeTrends(games, 10).gamesAnalyzed).toBe(10);
  });

  it('ranks the worst shortfall first', () => {
    const report = analyzeTrends([
      game({ csPerMin: 3, deaths: 4, deathsBefore10: 1, csAt10: 70 }),
      game({ csPerMin: 3, deaths: 4, deathsBefore10: 1, csAt10: 70 }),
    ]);
    expect(report.focusAreas[0]).toContain('CS per minute');
  });

  it('says nothing about metrics that are already on target', () => {
    const report = analyzeTrends([
      game({ csPerMin: 9, csAt10: 90, deaths: 1, deathsBefore10: 0, kills: 10, assists: 10 }),
      game({ csPerMin: 9, csAt10: 90, deaths: 1, deathsBefore10: 0, kills: 10, assists: 10 }),
    ]);
    expect(report.focusAreas).toEqual([]);
  });

  it('withholds a trend until there is enough data', () => {
    const report = analyzeTrends([game(), game()]);
    expect(report.metrics.every((m) => m.trend === null)).toBe(true);
  });

  it('computes a trend once the window is deep enough', () => {
    // Newest-first ordering means the recent half is the improved one.
    const games = [
      ...Array.from({ length: 4 }, (_, i) => game({ csPerMin: 9, endedAt: `2026-07-2${i}T00:00:00Z` })),
      ...Array.from({ length: 4 }, (_, i) => game({ csPerMin: 5, endedAt: `2026-07-0${i + 1}T00:00:00Z` })),
    ];
    const trend = analyzeTrends(games).metrics.find((m) => m.label === 'CS per minute')?.trend;
    expect(trend).toBeGreaterThan(0);
  });

  it('breaks results down per champion', () => {
    const report = analyzeTrends([
      game({ champion: 'Ahri', win: true }),
      game({ champion: 'Ahri', win: false }),
      game({ champion: 'Zed', win: true }),
    ]);
    const ahri = report.championBreakdown.find((c) => c.champion === 'Ahri')!;
    expect(ahri.games).toBe(2);
    expect(ahri.winRate).toBe(50);
    expect(report.championBreakdown[0]!.champion).toBe('Ahri');
  });

  it('excludes unknown results from champion win rates', () => {
    const report = analyzeTrends([
      game({ champion: 'Ahri', win: true }),
      game({ champion: 'Ahri', win: null }),
    ]);
    const ahri = report.championBreakdown.find((c) => c.champion === 'Ahri')!;
    expect(ahri.games).toBe(2);
    expect(ahri.winRate).toBe(100);
  });
});
