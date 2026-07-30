import { describe, expect, it } from 'vitest';
import { dragonsTakenBy, firstScuttleStatus, objectiveStatuses } from '../src/core/objectives.js';
import { DEFAULT_PATCH } from '../src/core/patch.js';
import type { GameEventRecord } from '../src/core/types.js';

function ev(
  id: number,
  kind: GameEventRecord['kind'],
  gameTime: number,
  extra: Partial<GameEventRecord> = {},
): GameEventRecord {
  return { id, kind, gameTime, ...extra };
}

describe('objective timers', () => {
  it('uses first-spawn times before anything has been killed', () => {
    const statuses = objectiveStatuses(60, []);
    const dragon = statuses.find((s) => s.id === 'dragon')!;
    const baron = statuses.find((s) => s.id === 'baron')!;
    expect(dragon.availableAt).toBe(DEFAULT_PATCH.dragonFirstSpawn);
    expect(baron.availableAt).toBe(DEFAULT_PATCH.baronFirstSpawn);
    expect(dragon.isUp).toBe(false);
  });

  it('marks an objective up once its spawn time has passed', () => {
    const dragon = objectiveStatuses(310, []).find((s) => s.id === 'dragon')!;
    expect(dragon.isUp).toBe(true);
  });

  it('derives the dragon respawn from the kill event', () => {
    const events = [ev(1, 'DragonKill', 400, { killer: 'Ally1', subtype: 'Fire' })];
    const dragon = objectiveStatuses(420, events).find((s) => s.id === 'dragon')!;
    expect(dragon.availableAt).toBe(400 + DEFAULT_PATCH.dragonRespawn);
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
    const dragon = objectiveStatuses(820, events).find((s) => s.id === 'dragon')!;
    expect(dragon.availableAt).toBe(800 + DEFAULT_PATCH.dragonRespawn);
    expect(dragon.takenCount).toBe(2);
    expect(dragon.lastTakenBy).toBe('Enemy1');
  });

  it('respawns baron on its own timer', () => {
    const events = [ev(1, 'BaronKill', 1600, { killer: 'Ally1' })];
    const baron = objectiveStatuses(1650, events).find((s) => s.id === 'baron')!;
    expect(baron.availableAt).toBe(1600 + DEFAULT_PATCH.baronRespawn);
  });

  it('retires herald permanently once taken', () => {
    const events = [ev(1, 'HeraldKill', 900, { killer: 'Ally1' })];
    const herald = objectiveStatuses(1000, events).find((s) => s.id === 'herald')!;
    expect(herald.availableAt).toBeNull();
  });

  it('stops scheduling grubs after the second set', () => {
    const events = [ev(1, 'HordeKill', 380), ev(2, 'HordeKill', 700)];
    const grubs = objectiveStatuses(800, events).find((s) => s.id === 'grubs')!;
    expect(grubs.availableAt).toBeNull();
  });

  it('drops an objective whose next spawn lands past its despawn time', () => {
    // A late first grub clear pushes the respawn beyond the 14:00 despawn.
    const events = [ev(1, 'HordeKill', 13 * 60)];
    const grubs = objectiveStatuses(13 * 60 + 30, events).find((s) => s.id === 'grubs')!;
    expect(grubs.availableAt).toBeNull();
  });

  it('reports the first scuttle spawn at 3:30', () => {
    expect(firstScuttleStatus(60).availableAt).toBe(210);
    expect(firstScuttleStatus(60).isUp).toBe(false);
    expect(firstScuttleStatus(240).isUp).toBe(true);
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
