import { describe, expect, it } from 'vitest';
import {
  buildWaveSchedule,
  nextBackWindow,
  nextCannonWave,
  nextWave,
  upcomingWaves,
} from '../src/core/waves.js';
import { DEFAULT_PATCH, stepValueAt, type PatchConfig } from '../src/core/patch.js';

/**
 * These assert the wave engine's *rules*, derived from whatever patch config is
 * loaded, rather than hardcoded clock values. Riot retunes these numbers every
 * season — the 2026 season changed the spawn interval into a stepped schedule —
 * and a suite full of literals turns every patch update into a wall of red that
 * says nothing about whether the engine is correct.
 *
 * Where a literal *is* the contract (the first cannon is wave 3), it is stated.
 */

/** A patch with a deliberately simple, non-default shape, for step coverage. */
const STEPPED: PatchConfig = {
  ...DEFAULT_PATCH,
  firstWaveSpawn: 30,
  waveIntervals: [
    { fromGameTime: 0, seconds: 30 },
    { fromGameTime: 600, seconds: 20 },
  ],
  cannonEvery: [
    { fromGameTime: 0, seconds: 3 },
    { fromGameTime: 600, seconds: 1 },
  ],
};

describe('wave schedule', () => {
  it('starts at the configured first spawn', () => {
    expect(buildWaveSchedule('mid')[0]!.spawnTime).toBe(DEFAULT_PATCH.firstWaveSpawn);
  });

  it('spaces waves by the interval in effect when each one spawned', () => {
    const waves = buildWaveSchedule('mid');
    for (let i = 1; i < waves.length; i++) {
      const previous = waves[i - 1]!;
      const gap = waves[i]!.spawnTime - previous.spawnTime;
      expect(gap).toBe(stepValueAt(DEFAULT_PATCH.waveIntervals, previous.spawnTime));
    }
  });

  it('accumulates rather than multiplying, so stepped intervals stay correct', () => {
    // With a constant-interval model this wave would land at 30 + n*30 forever.
    // The step at 10:00 must actually take effect.
    const waves = buildWaveSchedule('mid', STEPPED);
    const afterStep = waves.find((w) => w.spawnTime > 600)!;
    const before = waves[waves.indexOf(afterStep) - 1]!;
    expect(afterStep.spawnTime - before.spawnTime).toBe(20);
  });

  it('spawn times increase monotonically', () => {
    const waves = buildWaveSchedule('mid');
    for (let i = 1; i < waves.length; i++) {
      expect(waves[i]!.spawnTime).toBeGreaterThan(waves[i - 1]!.spawnTime);
    }
  });

  it('puts the first cannon on wave 3', () => {
    const waves = buildWaveSchedule('mid');
    expect(waves[0]!.hasCannon).toBe(false);
    expect(waves[1]!.hasCannon).toBe(false);
    expect(waves[2]!.hasCannon).toBe(true);
  });

  it('never leaves a gap longer than the cadence in effect', () => {
    const cannons = buildWaveSchedule('mid').filter((w) => w.hasCannon);
    for (let i = 1; i < cannons.length; i++) {
      const gap = cannons[i]!.index - cannons[i - 1]!.index;
      const cadence = stepValueAt(DEFAULT_PATCH.cannonEvery, cannons[i - 1]!.spawnTime);
      expect(gap).toBeGreaterThanOrEqual(1);
      expect(gap).toBeLessThanOrEqual(cadence);
    }
  });

  it('carries a cannon on every wave once the cadence reaches one', () => {
    const lastStep = DEFAULT_PATCH.cannonEvery.at(-1)!;
    if (lastStep.seconds !== 1) return;
    const late = buildWaveSchedule('mid').filter((w) => w.spawnTime >= lastStep.fromGameTime);
    expect(late.length).toBeGreaterThan(0);
    expect(late.every((w) => w.hasCannon)).toBe(true);
  });

  it('continues the cannon count across a cadence change rather than restarting', () => {
    const waves = buildWaveSchedule('mid', STEPPED);
    const boundary = waves.findIndex((w) => w.spawnTime >= 600);
    // No wave may be skipped: between any two cannons the gap stays within the
    // cadence, including the pair that straddles the step.
    const straddling = waves.slice(Math.max(0, boundary - 4), boundary + 4).filter((w) => w.hasCannon);
    for (let i = 1; i < straddling.length; i++) {
      expect(straddling[i]!.index - straddling[i - 1]!.index).toBeLessThanOrEqual(3);
    }
  });

  it('has mid waves arrive sooner than side lanes', () => {
    const mid = buildWaveSchedule('mid')[0]!;
    const top = buildWaveSchedule('top')[0]!;
    expect(mid.arrivalTime).toBeLessThan(top.arrivalTime);
    expect(mid.arrivalTime).toBe(DEFAULT_PATCH.firstWaveSpawn + DEFAULT_PATCH.laneTravelSeconds.mid);
  });
});

describe('lookups', () => {
  it('finds the next arriving wave', () => {
    const w = nextWave(100, 'mid')!;
    expect(w.arrivalTime).toBeGreaterThanOrEqual(100);
  });

  it('finds the next cannon wave, and advances past one that has landed', () => {
    const first = nextCannonWave(0, 'mid')!;
    expect(first.index).toBe(3);
    const later = nextCannonWave(first.arrivalTime + 1, 'mid')!;
    expect(later.index).toBeGreaterThan(first.index);
    expect(later.hasCannon).toBe(true);
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

  it('stays open while the player is standing in it', () => {
    // The regression this guards: anchoring to the *next* cannon made the
    // window disappear exactly when it became actionable.
    const win = nextBackWindow(0, 'mid')!;
    const midWindow = (win.opensAt + win.closesAt) / 2;
    const stillOpen = nextBackWindow(midWindow, 'mid')!;
    expect(stillOpen.cannonWave.index).toBe(win.cannonWave.index);
    expect(stillOpen.opensAt).toBeLessThanOrEqual(midWindow);
  });

  it('reports a round trip short enough to be worth taking', () => {
    const win = nextBackWindow(0, 'mid')!;
    expect(win.roundTripSeconds).toBe(
      DEFAULT_PATCH.recallSeconds + DEFAULT_PATCH.walkBackSeconds.mid,
    );
  });
});
