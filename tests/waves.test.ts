import { describe, expect, it } from 'vitest';
import {
  buildWaveSchedule,
  nextBackWindow,
  nextCannonWave,
  nextWave,
  upcomingWaves,
} from '../src/core/waves.js';
import { DEFAULT_PATCH } from '../src/core/patch.js';

describe('wave schedule', () => {
  it('spawns the first wave at 1:05 and every 30s after', () => {
    const waves = buildWaveSchedule('mid');
    expect(waves[0]!.spawnTime).toBe(65);
    expect(waves[1]!.spawnTime).toBe(95);
    expect(waves[2]!.spawnTime).toBe(125);
    expect(waves[9]!.spawnTime).toBe(65 + 9 * 30);
  });

  it('puts the first cannon on wave 3', () => {
    const waves = buildWaveSchedule('mid');
    expect(waves[0]!.hasCannon).toBe(false);
    expect(waves[1]!.hasCannon).toBe(false);
    expect(waves[2]!.hasCannon).toBe(true);
    expect(waves[2]!.spawnTime).toBe(125);
  });

  it('keeps cannons on every third wave before 15:00', () => {
    const waves = buildWaveSchedule('mid').filter((w) => w.spawnTime < DEFAULT_PATCH.cannonEveryTwoFrom);
    const cannonIndices = waves.filter((w) => w.hasCannon).map((w) => w.index);
    for (const index of cannonIndices) {
      expect(index % 3).toBe(0);
    }
    // 15:00 is 900s; waves spawn from 65s, so waves 1..28 are pre-15:00.
    expect(cannonIndices).toContain(3);
    expect(cannonIndices).toContain(27);
  });

  it('switches to every second wave after 15:00 and every wave after 25:00', () => {
    const waves = buildWaveSchedule('mid');

    const midGame = waves.filter(
      (w) => w.spawnTime >= DEFAULT_PATCH.cannonEveryTwoFrom && w.spawnTime < DEFAULT_PATCH.cannonEveryWaveFrom,
    );
    // Every other wave in the 15:00-25:00 band carries a cannon.
    const midCannons = midGame.filter((w) => w.hasCannon).length;
    expect(midCannons).toBeGreaterThanOrEqual(Math.floor(midGame.length / 2) - 1);
    expect(midCannons).toBeLessThanOrEqual(Math.ceil(midGame.length / 2) + 1);

    const lateGame = waves.filter((w) => w.spawnTime >= DEFAULT_PATCH.cannonEveryWaveFrom);
    expect(lateGame.every((w) => w.hasCannon)).toBe(true);
  });

  it('never leaves a gap longer than the current cadence', () => {
    const cannons = buildWaveSchedule('mid').filter((w) => w.hasCannon);
    for (let i = 1; i < cannons.length; i++) {
      const gap = cannons[i]!.index - cannons[i - 1]!.index;
      expect(gap).toBeLessThanOrEqual(3);
      expect(gap).toBeGreaterThanOrEqual(1);
    }
  });

  it('has mid waves arrive sooner than side lanes', () => {
    const mid = buildWaveSchedule('mid')[0]!;
    const top = buildWaveSchedule('top')[0]!;
    expect(mid.arrivalTime).toBeLessThan(top.arrivalTime);
    // First wave meets in mid at roughly 1:38.
    expect(mid.arrivalTime).toBeGreaterThanOrEqual(95);
    expect(mid.arrivalTime).toBeLessThanOrEqual(102);
  });
});

describe('lookups', () => {
  it('finds the next arriving wave', () => {
    const w = nextWave(100, 'mid');
    expect(w).not.toBeNull();
    expect(w!.arrivalTime).toBeGreaterThanOrEqual(100);
  });

  it('finds the next cannon wave', () => {
    const c = nextCannonWave(0, 'mid');
    expect(c!.index).toBe(3);
    // Just after wave 3 lands, the next cannon is wave 6.
    const later = nextCannonWave(c!.arrivalTime + 1, 'mid');
    expect(later!.index).toBe(6);
  });

  it('returns only waves inside the horizon', () => {
    const waves = upcomingWaves(300, 60, 'mid');
    expect(waves.length).toBeGreaterThan(0);
    for (const w of waves) {
      expect(w.arrivalTime).toBeGreaterThanOrEqual(300);
      expect(w.arrivalTime).toBeLessThanOrEqual(360);
    }
  });
});

describe('back window', () => {
  it('opens after the cannon wave is shoved and closes on the following wave', () => {
    const win = nextBackWindow(0, 'mid')!;
    expect(win.cannonWave.index).toBe(3);
    expect(win.opensAt).toBeGreaterThan(win.cannonWave.arrivalTime);
    expect(win.closesAt).toBeGreaterThan(win.opensAt);
  });

  it('includes a round trip short enough to fit the window', () => {
    const win = nextBackWindow(0, 'mid')!;
    expect(win.roundTripSeconds).toBe(
      DEFAULT_PATCH.recallSeconds + DEFAULT_PATCH.walkBackSeconds.mid,
    );
    expect(win.roundTripSeconds).toBeLessThan(win.closesAt - win.opensAt + 30);
  });
});
