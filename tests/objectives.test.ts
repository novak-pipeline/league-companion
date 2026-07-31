import { describe, expect, it } from 'vitest';
import { dragonsTakenBy, firstScuttleStatus, objectiveStatuses } from '../src/core/objectives.js';
import { DEFAULT_PATCH, stepValueAt, type PatchConfig } from '../src/core/patch.js';
import { buildWaveSchedule } from '../src/core/waves.js';
import type { GameEventRecord } from '../src/core/types.js';

function ev(
  id: number,
  kind: GameEventRecord['kind'],
  gameTime: number,
  extra: Partial<GameEventRecord> = {},
): GameEventRecord {
  return { id, kind, gameTime, ...extra };
}

const find = (statuses: ReturnType<typeof objectiveStatuses>, id: string) =>
  statuses.find((s) => s.id === id);

describe('objective timers', () => {
  it('uses the configured first-spawn times before anything is killed', () => {
    const statuses = objectiveStatuses(60, []);
    expect(find(statuses, 'dragon')!.availableAt).toBe(DEFAULT_PATCH.dragon.firstSpawn);
    expect(find(statuses, 'baron')!.availableAt).toBe(DEFAULT_PATCH.baron.firstSpawn);
    expect(find(statuses, 'dragon')!.isUp).toBe(false);
  });

  it('marks an objective up once its spawn time has passed', () => {
    const at = DEFAULT_PATCH.dragon.firstSpawn + 10;
    expect(find(objectiveStatuses(at, []), 'dragon')!.isUp).toBe(true);
  });

  it('derives the respawn from the kill event', () => {
    const killedAt = DEFAULT_PATCH.dragon.firstSpawn + 40;
    const events = [ev(1, 'DragonKill', killedAt, { killer: 'Ally1', subtype: 'Fire' })];
    const dragon = find(objectiveStatuses(killedAt + 20, events), 'dragon')!;
    expect(dragon.availableAt).toBe(killedAt + DEFAULT_PATCH.dragon.respawn!);
    expect(dragon.isUp).toBe(false);
    expect(dragon.takenCount).toBe(1);
    expect(dragon.lastTakenBy).toBe('Ally1');
    expect(dragon.lastSubtype).toBe('Fire');
  });

  it('uses the most recent kill when several have happened', () => {
    const events = [
      ev(1, 'DragonKill', 400, { killer: 'Ally1' }),
      ev(2, 'DragonKill', 800, { killer: 'Enemy1' }),
    ];
    const dragon = find(objectiveStatuses(820, events), 'dragon')!;
    expect(dragon.availableAt).toBe(800 + DEFAULT_PATCH.dragon.respawn!);
    expect(dragon.takenCount).toBe(2);
    expect(dragon.lastTakenBy).toBe('Enemy1');
  });

  it('respawns baron on its own timer', () => {
    const killedAt = DEFAULT_PATCH.baron.firstSpawn + 100;
    const baron = find(objectiveStatuses(killedAt + 30, [ev(1, 'BaronKill', killedAt)]), 'baron')!;
    expect(baron.availableAt).toBe(killedAt + DEFAULT_PATCH.baron.respawn!);
  });

  it('retires an objective that never respawns once taken', () => {
    const herald = find(objectiveStatuses(1000, [ev(1, 'HeraldKill', 900)]), 'herald')!;
    expect(herald.availableAt).toBeNull();
  });

  it('honours a spawn cap', () => {
    // Grubs are a single set on the 2026 season; taking them retires them.
    const grubs = find(
      objectiveStatuses(DEFAULT_PATCH.grubs.firstSpawn + 60, [
        ev(1, 'HordeKill', DEFAULT_PATCH.grubs.firstSpawn + 20),
      ]),
      'grubs',
    )!;
    expect(grubs.availableAt).toBeNull();
  });

  it('drops an objective whose next spawn would land past its despawn', () => {
    const patch: PatchConfig = {
      ...DEFAULT_PATCH,
      grubs: { enabled: true, firstSpawn: 360, respawn: 300, despawn: 840, maxSpawns: null },
    };
    const grubs = find(objectiveStatuses(600, [ev(1, 'HordeKill', 700)], patch), 'grubs')!;
    expect(grubs.availableAt).toBeNull();
  });

  it('omits objectives that do not exist on this patch', () => {
    // Atakhan was removed in patch 26.1; a disabled objective must not appear
    // at all rather than showing a timer for something that cannot spawn.
    const patch: PatchConfig = {
      ...DEFAULT_PATCH,
      grubs: { ...DEFAULT_PATCH.grubs, enabled: false },
    };
    expect(find(objectiveStatuses(60, [], patch), 'grubs')).toBeUndefined();
  });

  it('does not report a scuttle status when scuttle is disabled', () => {
    const patch: PatchConfig = {
      ...DEFAULT_PATCH,
      scuttle: { ...DEFAULT_PATCH.scuttle, enabled: false },
    };
    expect(firstScuttleStatus(60, patch)).toBeNull();
  });

  it('reports the first scuttle spawn from config', () => {
    const at = DEFAULT_PATCH.scuttle.firstSpawn;
    expect(firstScuttleStatus(60)!.availableAt).toBe(at);
    expect(firstScuttleStatus(60)!.isUp).toBe(false);
    expect(firstScuttleStatus(at + 5)!.isUp).toBe(true);
  });
});

describe('2026 season config', () => {
  it('has Baron at 20 minutes', () => {
    // Patch 26.1 moved Baron back from 25:00.
    expect(DEFAULT_PATCH.baron.firstSpawn).toBe(20 * 60);
  });

  it('spawns grubs only once', () => {
    expect(DEFAULT_PATCH.grubs.maxSpawns).toBe(1);
  });

  it('has no objective that Riot has removed', () => {
    const ids = objectiveStatuses(60, []).map((s) => s.id);
    expect(ids).not.toContain('atakhan');
  });
});

describe('dragon accounting', () => {
  it('groups dragon types by killer', () => {
    const events = [
      ev(1, 'DragonKill', 400, { killer: 'Ally1', subtype: 'Fire' }),
      ev(2, 'DragonKill', 800, { killer: 'Ally1', subtype: 'Air' }),
      ev(3, 'DragonKill', 1200, { killer: 'Enemy1', subtype: 'Earth' }),
    ];
    const map = dragonsTakenBy(events);
    expect(map.get('Ally1')).toEqual(['Fire', 'Air']);
    expect(map.get('Enemy1')).toEqual(['Earth']);
  });
});

describe('patch honesty', () => {
  it('lists a caveat for every value the research could not confirm', () => {
    const fields = DEFAULT_PATCH.caveats.map((c) => c.field);
    // These four are the ones sources actually disagreed on. If a future patch
    // update confirms one, remove it here and from the config together.
    expect(fields).toContain('laneTravelSeconds');
    expect(fields).toContain('cannonEvery');
    expect(fields).toContain('herald.firstSpawn');
    expect(fields).toContain('grubs.despawn');
  });

  it('gives every caveat an explanation, not just a field name', () => {
    for (const caveat of DEFAULT_PATCH.caveats) {
      expect(caveat.note.length).toBeGreaterThan(20);
    }
  });

  it('says in its label that it is not fully verified', () => {
    expect(DEFAULT_PATCH.label.toLowerCase()).toMatch(/unverified|caveat|verify/);
  });
});

describe('2026 corrections', () => {
  it('spawns grubs at 8:00, not the pre-25.09 6:00', () => {
    expect(DEFAULT_PATCH.grubs.firstSpawn).toBe(8 * 60);
  });

  it('keeps the herald despawn consistent with the baron spawn', () => {
    // Herald sits in the Baron pit, so it cannot outlive Baron's arrival.
    expect(DEFAULT_PATCH.herald.despawn!).toBeLessThanOrEqual(DEFAULT_PATCH.baron.firstSpawn);
  });

  it('does not let grubs outlive the herald spawn', () => {
    expect(DEFAULT_PATCH.grubs.despawn!).toBeLessThanOrEqual(DEFAULT_PATCH.herald.firstSpawn);
  });

  it('starts the first wave at 0:30', () => {
    expect(DEFAULT_PATCH.firstWaveSpawn).toBe(30);
  });

  it('steps the wave interval down at 14:00 and 30:00', () => {
    expect(stepValueAt(DEFAULT_PATCH.waveIntervals, 0)).toBe(30);
    expect(stepValueAt(DEFAULT_PATCH.waveIntervals, 14 * 60)).toBe(25);
    expect(stepValueAt(DEFAULT_PATCH.waveIntervals, 30 * 60)).toBe(20);
  });

  it('puts the first cannon wave at 1:30', () => {
    // 0:30 + two 30s intervals. Corroborates the reported siege timing.
    const waves = buildWaveSchedule('mid');
    expect(waves.find((w) => w.hasCannon)!.spawnTime).toBe(90);
  });
});
