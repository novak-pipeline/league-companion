import { describe, expect, it } from 'vitest';
import { applyDensity, buildCues } from '../src/core/cues.js';
import type { Cue } from '../src/core/types.js';
import type { GameSnapshot, ManualTimer } from '../src/core/types.js';

function snapshotAt(gameTime: number, events: GameSnapshot['events'] = []): GameSnapshot {
  return {
    gameTime,
    gameMode: 'CLASSIC',
    mapName: "Summoner's Rift",
    self: null,
    selfTeam: 'ORDER',
    players: [],
    events,
  };
}

describe('cue engine', () => {
  it('is deterministic for a given snapshot', () => {
    const snap = snapshotAt(200);
    expect(buildCues(snap)).toEqual(buildCues(snap));
  });

  it('surfaces the next cannon wave', () => {
    // Wave 3 (the first cannon) arrives at 125 + 33 = 158s.
    const cues = buildCues(snapshotAt(140));
    const cannon = cues.find((c) => c.kind === 'cannon');
    expect(cannon).toBeDefined();
    expect(cannon!.etaSeconds).toBeCloseTo(18, 0);
  });

  it('escalates severity as an event approaches', () => {
    const far = buildCues(snapshotAt(120)).find((c) => c.kind === 'cannon');
    const near = buildCues(snapshotAt(155)).find((c) => c.kind === 'cannon');
    expect(far!.severity).toBe('soon');
    expect(near!.severity).toBe('urgent');
  });

  it('drops cues beyond the horizon', () => {
    const cues = buildCues(snapshotAt(0), [], { horizonSeconds: 10 });
    expect(cues.every((c) => c.etaSeconds === null || c.etaSeconds <= 10)).toBe(true);
  });

  it('warns before the first scuttle spawns', () => {
    const cues = buildCues(snapshotAt(180));
    const scuttle = cues.find((c) => c.kind === 'scuttle');
    expect(scuttle).toBeDefined();
    expect(scuttle!.etaSeconds).toBe(30);
  });

  it('stops showing scuttle once it is up', () => {
    const cues = buildCues(snapshotAt(240));
    expect(cues.find((c) => c.kind === 'scuttle')).toBeUndefined();
  });

  it('marks a live objective with a null eta', () => {
    const cues = buildCues(snapshotAt(305));
    const dragon = cues.find((c) => c.kind === 'dragon');
    expect(dragon).toBeDefined();
    expect(dragon!.etaSeconds).toBeNull();
    expect(dragon!.label).toContain('UP');
  });

  it('sorts live cues ahead of pending ones', () => {
    const cues = buildCues(snapshotAt(305));
    const firstPending = cues.findIndex((c) => c.etaSeconds !== null);
    const lastLive = cues.map((c) => c.etaSeconds).lastIndexOf(null);
    if (firstPending !== -1 && lastLive !== -1) {
      expect(lastLive).toBeLessThan(firstPending);
    }
  });

  it('includes user-started manual timers', () => {
    const timers: ManualTimer[] = [
      { id: 't1', label: 'Scuttle (top)', kind: 'scuttle', startedAtGameTime: 400, durationSeconds: 150 },
    ];
    const cues = buildCues(snapshotAt(500), timers);
    const manual = cues.find((c) => c.kind === 'manual');
    expect(manual).toBeDefined();
    expect(manual!.etaSeconds).toBe(50);
  });

  it('drops manual timers once they expire', () => {
    const timers: ManualTimer[] = [
      { id: 't1', label: 'Scuttle', kind: 'scuttle', startedAtGameTime: 100, durationSeconds: 150 },
    ];
    expect(buildCues(snapshotAt(300), timers).find((c) => c.kind === 'manual')).toBeUndefined();
  });

  it('honours muted kinds', () => {
    const cues = buildCues(snapshotAt(140), [], { mutedKinds: ['cannon'] });
    expect(cues.find((c) => c.kind === 'cannon')).toBeUndefined();
  });

  it('opens a back window after the cannon wave lands', () => {
    // Cannon wave 3 arrives at 158s; the following wave lands at 188s.
    const cues = buildCues(snapshotAt(190), [], { horizonSeconds: 90 });
    const back = cues.find((c) => c.kind === 'back');
    expect(back).toBeDefined();
    expect(back!.label).toContain('OPEN');
  });

  it('never emits a negative countdown', () => {
    for (let t = 0; t < 2000; t += 7) {
      for (const cue of buildCues(snapshotAt(t))) {
        if (cue.etaSeconds !== null) expect(cue.etaSeconds).toBeGreaterThanOrEqual(0);
      }
    }
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
      const result = applyDensity(mixed, density);
      expect(result.every((c) => c.severity !== 'idle')).toBe(true);
    }
  });

  it('shows a single cue at minimal density', () => {
    expect(applyDensity(mixed, 'minimal')).toHaveLength(1);
  });

  it('caps normal density at three', () => {
    expect(applyDensity(mixed, 'normal')).toHaveLength(3);
  });

  it('never drops a live cue, even past the limit', () => {
    const allLive = [cue('a', 'now', null), cue('b', 'now', null), cue('c', 'now', null)];
    expect(applyDensity(allLive, 'minimal')).toHaveLength(3);
  });

  it('puts live cues ahead of countdowns', () => {
    const result = applyDensity(mixed, 'normal');
    expect(result[0]!.id).toBe('live');
  });

  it('returns nothing when everything is idle', () => {
    const idle = [cue('a', 'idle', 90), cue('b', 'idle', 100)];
    expect(applyDensity(idle, 'minimal')).toHaveLength(0);
    expect(applyDensity(idle, 'normal')).toHaveLength(0);
  });

  it('handles an empty list', () => {
    expect(applyDensity([], 'normal')).toEqual([]);
  });
});
