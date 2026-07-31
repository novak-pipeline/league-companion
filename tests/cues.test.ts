import { describe, expect, it } from 'vitest';
import { applyDensity, buildCues } from '../src/core/cues.js';
import { makeCsBaseline } from '../src/core/insights.js';
import { DEFAULT_PATCH } from '../src/core/patch.js';
import { nextCannonWave } from '../src/core/waves.js';
import { MIRRORED_CUE_KINDS } from '../src/core/types.js';
import type { Cue, GameRecord, GameSnapshot, ManualTimer, PlayerState } from '../src/core/types.js';

function player(overrides: Partial<PlayerState> = {}): PlayerState {
  return {
    summonerName: 'Me',
    championName: 'Ahri',
    team: 'ORDER',
    position: 'mid',
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

function snapshotAt(
  gameTime: number,
  events: GameSnapshot['events'] = [],
  players: PlayerState[] = [],
): GameSnapshot {
  const self = players[0] ?? null;
  return {
    gameTime,
    gameMode: 'CLASSIC',
    mapName: "Summoner's Rift",
    self,
    selfTeam: 'ORDER',
    players,
    events,
  };
}

describe('cue engine', () => {
  it('is deterministic for a given snapshot', () => {
    const snap = snapshotAt(200);
    expect(buildCues(snap)).toEqual(buildCues(snap));
  });

  it('surfaces the next cannon wave with the right countdown', () => {
    const cannon = nextCannonWave(0, 'mid', DEFAULT_PATCH)!;
    const at = cannon.arrivalTime - 18;
    const cue = buildCues(snapshotAt(at)).find((c) => c.kind === 'cannon')!;
    expect(cue).toBeDefined();
    expect(cue.etaSeconds).toBeCloseTo(18, 0);
  });

  it('escalates severity as an event approaches', () => {
    const cannon = nextCannonWave(0, 'mid', DEFAULT_PATCH)!;
    const far = buildCues(snapshotAt(cannon.arrivalTime - 30)).find((c) => c.kind === 'cannon')!;
    const near = buildCues(snapshotAt(cannon.arrivalTime - 3)).find((c) => c.kind === 'cannon')!;
    expect(far.severity).toBe('soon');
    expect(near.severity).toBe('urgent');
  });

  it('drops cues beyond the horizon', () => {
    const cues = buildCues(snapshotAt(0), [], { horizonSeconds: 10 });
    expect(cues.every((c) => c.etaSeconds === null || c.etaSeconds <= 10)).toBe(true);
  });

  it('marks a live objective with a null eta', () => {
    const at = DEFAULT_PATCH.dragon.firstSpawn + 5;
    const dragon = buildCues(snapshotAt(at)).find((c) => c.kind === 'dragon')!;
    expect(dragon.etaSeconds).toBeNull();
    expect(dragon.label).toContain('UP');
  });

  it('sorts live cues ahead of pending ones', () => {
    const cues = buildCues(snapshotAt(DEFAULT_PATCH.dragon.firstSpawn + 5));
    const firstPending = cues.findIndex((c) => c.etaSeconds !== null);
    const lastLive = cues.map((c) => c.etaSeconds).lastIndexOf(null);
    if (firstPending !== -1 && lastLive !== -1) expect(lastLive).toBeLessThan(firstPending);
  });

  it('includes user-started manual timers and drops them when they expire', () => {
    const timers: ManualTimer[] = [
      { id: 't1', label: 'Scuttle', kind: 'scuttle', startedAtGameTime: 400, durationSeconds: 150 },
    ];
    expect(buildCues(snapshotAt(500), timers).find((c) => c.kind === 'manual')?.etaSeconds).toBe(50);
    expect(buildCues(snapshotAt(600), timers).find((c) => c.kind === 'manual')).toBeUndefined();
  });

  it('honours muted kinds', () => {
    const cannon = nextCannonWave(0, 'mid', DEFAULT_PATCH)!;
    const cues = buildCues(snapshotAt(cannon.arrivalTime - 10), [], { mutedKinds: ['cannon'] });
    expect(cues.find((c) => c.kind === 'cannon')).toBeUndefined();
  });

  it('never emits a negative countdown', () => {
    for (let t = 0; t < 2400; t += 7) {
      for (const cue of buildCues(snapshotAt(t))) {
        if (cue.etaSeconds !== null) expect(cue.etaSeconds).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

describe('derived insight', () => {
  it('flags the enemy jungler clear window', () => {
    const at = DEFAULT_PATCH.jungleFirstClearDone - 10;
    const cue = buildCues(snapshotAt(at)).find((c) => c.kind === 'jungle');
    expect(cue).toBeDefined();
    expect(cue!.etaSeconds).toBeCloseTo(10, 0);
  });

  it('stops mentioning a jungle window long after it passed', () => {
    const at = DEFAULT_PATCH.jungleFirstClearDone + 120;
    const cues = buildCues(snapshotAt(at)).filter((c) => c.id === 'jungle-1');
    expect(cues).toHaveLength(0);
  });

  it('warns when the lane opponent hits a level breakpoint first', () => {
    const me = player({ level: 5 });
    const them = player({
      summonerName: 'Them', championName: 'Zed', team: 'CHAOS', position: 'mid', level: 6,
    });
    const cue = buildCues(snapshotAt(500, [], [me, them])).find((c) => c.kind === 'spike');
    expect(cue).toBeDefined();
    expect(cue!.label).toContain('6');
  });

  it('says nothing about spikes when you are level-even or ahead', () => {
    const me = player({ level: 6 });
    const them = player({
      summonerName: 'Them', championName: 'Zed', team: 'CHAOS', position: 'mid', level: 6,
    });
    expect(buildCues(snapshotAt(500, [], [me, them])).find((c) => c.kind === 'spike')).toBeUndefined();
  });

  it('does not invent a spike warning without an identifiable opponent', () => {
    const me = player({ level: 5 });
    expect(buildCues(snapshotAt(500, [], [me])).find((c) => c.kind === 'spike')).toBeUndefined();
  });

  it('stays silent on CS pace without enough history', () => {
    const me = player({ creepScore: 10 });
    const cues = buildCues(snapshotAt(600, [], [me]), [], { history: [] });
    expect(cues.find((c) => c.kind === 'pace')).toBeUndefined();
  });

  it('reports CS pace against your own baseline once history exists', () => {
    const history: GameRecord[] = Array.from({ length: 6 }, (_, i) => ({
      id: `g${i}`,
      startedAt: '2026-07-01T00:00:00Z',
      endedAt: `2026-07-0${i + 1}T00:30:00Z`,
      gameMode: 'CLASSIC',
      champion: 'Ahri',
      win: true,
      durationSeconds: 1800,
      kills: 5, deaths: 3, assists: 5,
      cs: 220, csPerMin: 7.3,
      csAt10: 70, csAt15: 110, csDiffAt10: 0,
      deathsBefore10: 1,
      laneOpponent: 'Zed',
      samples: [
        { gameTime: 300, cs: 35, kills: 0, deaths: 0, assists: 0, level: 5 },
        { gameTime: 600, cs: 70, kills: 0, deaths: 0, assists: 0, level: 8 },
      ],
    }));

    // 70 is the historical average at 10:00; showing up with 45 is well behind.
    const me = player({ creepScore: 45 });
    const cue = buildCues(snapshotAt(600, [], [me]), [], { history }).find((c) => c.kind === 'pace');
    expect(cue).toBeDefined();
    expect(cue!.label).toContain('25');
  });

  it('says nothing when CS pace is on or above baseline', () => {
    const baseline = makeCsBaseline(
      Array.from({ length: 6 }, (_, i) => ({
        id: `g${i}`,
        startedAt: '2026-07-01T00:00:00Z',
        endedAt: `2026-07-0${i + 1}T00:30:00Z`,
        gameMode: 'CLASSIC',
        champion: 'Ahri',
        win: true,
        durationSeconds: 1800,
        kills: 0, deaths: 0, assists: 0,
        cs: 200, csPerMin: 6.7,
        csAt10: 70, csAt15: 110, csDiffAt10: 0,
        deathsBefore10: 0,
        laneOpponent: null,
        samples: [{ gameTime: 600, cs: 70, kills: 0, deaths: 0, assists: 0, level: 8 }],
      })),
    );
    expect(baseline).not.toBeNull();
    expect(baseline!(600)).toBe(70);
  });
});

describe('overlay density', () => {
  function cue(id: string, severity: Cue['severity'], etaSeconds: number | null): Cue {
    return { id, kind: 'reminder', label: id, etaSeconds, severity, sortKey: 10 };
  }

  const mixed: Cue[] = [
    cue('live', 'now', null),
    cue('urgent', 'urgent', 4),
    cue('soon', 'soon', 25),
    cue('idle1', 'idle', 60),
    cue('idle2', 'idle', 70),
  ];

  it('passes everything through at full density', () => {
    expect(applyDensity(mixed, 'full')).toEqual(mixed);
  });

  it('drops idle cues below full density', () => {
    for (const density of ['minimal', 'normal'] as const) {
      expect(applyDensity(mixed, density).every((c) => c.severity !== 'idle')).toBe(true);
    }
  });

  it('shows a single cue at minimal density and caps normal at three', () => {
    expect(applyDensity(mixed, 'minimal')).toHaveLength(1);
    expect(applyDensity(mixed, 'normal')).toHaveLength(3);
  });

  it('never drops a live cue, even past the limit', () => {
    const allLive = [cue('a', 'now', null), cue('b', 'now', null), cue('c', 'now', null)];
    expect(applyDensity(allLive, 'minimal')).toHaveLength(3);
  });

  it('puts live cues ahead of countdowns', () => {
    expect(applyDensity(mixed, 'normal')[0]!.id).toBe('live');
  });

  it('returns nothing when everything is idle, and handles an empty list', () => {
    const idle = [cue('a', 'idle', 90), cue('b', 'idle', 100)];
    expect(applyDensity(idle, 'minimal')).toHaveLength(0);
    expect(applyDensity([], 'normal')).toEqual([]);
  });
});

describe('overlay defaults do not mirror the game HUD', () => {
  it('mutes every cue kind League already shows on its own scoreboard', () => {
    const cues = buildCues(snapshotAt(DEFAULT_PATCH.dragon.firstSpawn + 5), [], {
      mutedKinds: MIRRORED_CUE_KINDS,
    });
    for (const kind of MIRRORED_CUE_KINDS) {
      expect(cues.find((c) => c.kind === kind)).toBeUndefined();
    }
  });

  it('still leaves derived cues visible once the mirrored ones are muted', () => {
    const cannon = nextCannonWave(0, 'mid', DEFAULT_PATCH)!;
    const cues = buildCues(snapshotAt(cannon.arrivalTime - 10), [], {
      mutedKinds: MIRRORED_CUE_KINDS,
    });
    expect(cues.some((c) => c.kind === 'cannon' || c.kind === 'back')).toBe(true);
  });
});
