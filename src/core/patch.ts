/**
 * Patch-dependent timing constants.
 *
 * Riot changes these often — objective spawn times in particular have moved
 * several times per season. Everything the timer engine needs is here so a
 * patch update is a one-file edit, and the UI can show which config is loaded
 * rather than quietly being wrong.
 *
 * VERIFY AGAINST CURRENT PATCH NOTES before trusting the numbers in a ranked
 * game. `label` is displayed in the companion's settings panel.
 */
export interface PatchConfig {
  label: string;

  /** Game time (s) at which the first minion wave leaves the spawn platform. */
  firstWaveSpawn: number;
  /** Interval (s) between wave spawns. */
  waveInterval: number;
  /**
   * Cannon (siege) minion cadence. Before `cannonEveryTwoFrom` a cannon rides
   * with every 3rd wave; between that and `cannonEveryWaveFrom` every 2nd; and
   * after, every wave.
   */
  cannonEveryTwoFrom: number;
  cannonEveryWaveFrom: number;
  /** Extra seconds for a freshly spawned wave to reach the lane's midpoint. */
  laneTravelSeconds: Record<'top' | 'mid' | 'bot', number>;

  /** First spawn times (s). */
  scuttleFirstSpawn: number;
  scuttleRespawn: number;
  dragonFirstSpawn: number;
  dragonRespawn: number;
  grubsFirstSpawn: number;
  /** Grubs despawn when Herald arrives; null disables the reminder. */
  grubsDespawn: number | null;
  heraldFirstSpawn: number;
  heraldDespawn: number | null;
  atakhanFirstSpawn: number | null;
  baronFirstSpawn: number;
  baronRespawn: number;

  /** Recall channel time (s). */
  recallSeconds: number;
  /** Rough walk time from fountain back to lane, per lane. */
  walkBackSeconds: Record<'top' | 'mid' | 'bot', number>;
}

/**
 * Defaults reflect the 2026 season as of this writing. Cross-check when a new
 * patch lands; `npm run refresh-champions` does not update these.
 */
export const DEFAULT_PATCH: PatchConfig = {
  label: '2026 season defaults (verify vs. current patch)',

  firstWaveSpawn: 65,
  waveInterval: 30,
  cannonEveryTwoFrom: 15 * 60,
  cannonEveryWaveFrom: 25 * 60,
  laneTravelSeconds: { top: 38, mid: 33, bot: 38 },

  scuttleFirstSpawn: 3 * 60 + 30,
  scuttleRespawn: 2 * 60 + 30,
  dragonFirstSpawn: 5 * 60,
  dragonRespawn: 5 * 60,
  grubsFirstSpawn: 6 * 60,
  grubsDespawn: 14 * 60,
  heraldFirstSpawn: 14 * 60,
  heraldDespawn: 19 * 60 + 45,
  atakhanFirstSpawn: 20 * 60,
  baronFirstSpawn: 25 * 60,
  baronRespawn: 6 * 60,

  recallSeconds: 8,
  walkBackSeconds: { top: 15, mid: 11, bot: 15 },
};
