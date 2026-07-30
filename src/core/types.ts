/**
 * Core domain contract.
 *
 * Everything in `src/core` is pure: no Electron, no network, no clock reads.
 * Adapters in `src/services` translate the outside world (Riot's Live Client
 * Data API, the League client's LCU API) into these shapes, and the renderers
 * only ever consume them. Keep this file stable — the cue stream is the seam
 * the overlay and companion windows are both built on.
 */

export type Lane = 'top' | 'mid' | 'bot';
export type Team = 'ORDER' | 'CHAOS';
export type Role = 'top' | 'jungle' | 'mid' | 'adc' | 'support';

// ---------------------------------------------------------------------------
// Normalized live-game state
// ---------------------------------------------------------------------------

/** A player as seen in the live game. */
export interface PlayerState {
  summonerName: string;
  championName: string;
  team: Team;
  /** Riot reports this only in some queues; may be undefined. */
  position?: Role;
  level: number;
  isDead: boolean;
  respawnTimer: number;
  kills: number;
  deaths: number;
  assists: number;
  creepScore: number;
  wardScore: number;
  items: string[];
}

/** Things that happened, normalized from the live event feed. */
export type GameEventKind =
  | 'GameStart'
  | 'MinionsSpawning'
  | 'FirstBlood'
  | 'ChampionKill'
  | 'Multikill'
  | 'Ace'
  | 'TurretKilled'
  | 'InhibKilled'
  | 'DragonKill'
  | 'HeraldKill'
  | 'BaronKill'
  | 'AtakhanKill'
  | 'HordeKill'
  | 'Unknown';

export interface GameEventRecord {
  id: number;
  kind: GameEventKind;
  gameTime: number;
  /** Present on objective kills: 'Air'|'Fire'|'Elder'|... for dragons. */
  subtype?: string;
  killer?: string;
  victim?: string;
  assisters?: string[];
  /** True when the event was stolen (Riot flags this on objectives). */
  stolen?: boolean;
}

/** One poll of the live game, normalized. */
export interface GameSnapshot {
  /** Seconds since game start (0:00 is the in-game clock zero). */
  gameTime: number;
  gameMode: string;
  mapName: string;
  /** The local player, resolved out of `players`. */
  self: PlayerState | null;
  selfTeam: Team | null;
  players: PlayerState[];
  events: GameEventRecord[];
}

// ---------------------------------------------------------------------------
// Cue stream — the overlay's only input
// ---------------------------------------------------------------------------

export type CueKind =
  | 'wave'
  | 'cannon'
  | 'scuttle'
  | 'dragon'
  | 'herald'
  | 'grubs'
  | 'baron'
  | 'atakhan'
  | 'back'
  | 'manual'
  | 'reminder';

/**
 * How loud the cue should be. The overlay maps these to colour and size; the
 * thresholds live in `cues.ts` so the renderer stays dumb.
 */
export type CueSeverity = 'idle' | 'soon' | 'now' | 'urgent';

export interface Cue {
  /** Stable across polls so the UI can animate rather than re-mount. */
  id: string;
  kind: CueKind;
  label: string;
  detail?: string;
  /** Seconds until the thing happens. Null when it is live/available now. */
  etaSeconds: number | null;
  severity: CueSeverity;
  lane?: Lane;
  /** Ascending display order; lower sorts first. */
  sortKey: number;
}

// ---------------------------------------------------------------------------
// Manual timers (for state Riot does not expose)
// ---------------------------------------------------------------------------

/**
 * Riot's API does not report scuttle respawns or enemy summoner cooldowns, and
 * automatically deriving enemy cooldowns is against Riot's third-party policy.
 * These are user-started timers only — the app never infers them.
 */
export interface ManualTimer {
  id: string;
  label: string;
  kind: 'scuttle' | 'summoner' | 'custom';
  /** Game time at which the user started the timer. */
  startedAtGameTime: number;
  durationSeconds: number;
  lane?: Lane;
}

// ---------------------------------------------------------------------------
// Draft
// ---------------------------------------------------------------------------

export type ChampClass =
  | 'tank'
  | 'fighter'
  | 'assassin'
  | 'mage'
  | 'marksman'
  | 'enchanter'
  | 'catcher';

export type DamageProfile = 'physical' | 'magic' | 'mixed';
export type ScalingCurve = 'early' | 'mid' | 'late';

export interface ChampionData {
  /** Data Dragon key, e.g. "Ahri", "MonkeyKing". */
  id: string;
  name: string;
  classes: ChampClass[];
  damage: DamageProfile;
  range: 'melee' | 'ranged';
  /** 0-3 scales: how much the kit brings of each. */
  cc: number;
  engage: number;
  peel: number;
  waveclear: number;
  scaling: ScalingCurve;
  roles: Role[];
}

export interface DraftPick {
  championId: string;
  role?: Role;
}

export interface DraftState {
  allies: DraftPick[];
  enemies: DraftPick[];
  bans: string[];
  /** The role the local player is picking for, when known. */
  myRole?: Role;
  /** True while the local player is actively choosing. */
  isMyTurn: boolean;
}

export interface CompAnalysis {
  /** Percentages, summing to ~100. */
  damageMix: { physical: number; magic: number };
  frontline: number;
  engage: number;
  peel: number;
  waveclear: number;
  cc: number;
  scaling: { early: number; mid: number; late: number };
  /** 0-100 "is this comp functional", not a win probability. */
  score: number;
  flags: CompFlag[];
}

export interface CompFlag {
  severity: 'info' | 'warn' | 'critical';
  message: string;
}

export interface DraftSuggestion {
  championId: string;
  name: string;
  /** 0-100, how well the pick fills the current gaps in the comp. */
  fitScore: number;
  /** Short reasons, e.g. "adds magic damage", "only frontline option". */
  reasons: string[];
  /** Populated from the local match history when the champion has been played. */
  personal?: { games: number; wins: number; winRate: number };
  /** Aggregate performance on the current patch, when meta data is available. */
  meta?: ChampionMetaStats;
}

// ---------------------------------------------------------------------------
// Meta / patch-tracked aggregate data
// ---------------------------------------------------------------------------

/**
 * Aggregate performance for one champion (optionally in one role) on a patch.
 * Sourced from real sampled matches — never invented. `games` is always the
 * honest denominator so the UI can hide thin samples.
 */
export interface ChampionMetaStats {
  championId: string;
  role?: Role;
  games: number;
  wins: number;
  /** Percentage 0-100. */
  winRate: number;
  /** Percentage of sampled matches the champion appeared in. */
  pickRate: number;
  banRate?: number;
  patch: string;
}

export type MetaSource = 'riot-api-sample' | 'imported' | 'none';

export interface MetaSnapshot {
  patch: string;
  updatedAt: string;
  /** Number of distinct matches behind these numbers. */
  sampleSize: number;
  source: MetaSource;
  byChampion: ChampionMetaStats[];
}

/** What the UI shows in its "where is this data from" panel. */
export interface DataSourceStatus {
  ddragon: { patch: string | null; championCount: number; updatedAt: string | null; ok: boolean };
  meta: { patch: string | null; sampleSize: number; updatedAt: string | null; source: MetaSource };
  riotApi: { configured: boolean; lastError: string | null };
  personalMatches: number;
}

export interface DraftAdvice {
  ally: CompAnalysis;
  enemy: CompAnalysis;
  /** Human-readable comparisons, e.g. "you scale better past 30 min". */
  edges: string[];
  suggestions: DraftSuggestion[];
}

// ---------------------------------------------------------------------------
// Tracking
// ---------------------------------------------------------------------------

/** A sample taken during a game, used to derive @10 / @15 benchmarks. */
export interface TimelineSample {
  gameTime: number;
  cs: number;
  kills: number;
  deaths: number;
  assists: number;
  level: number;
  /** Direct lane opponent's CS, when the opponent could be identified. */
  opponentCs?: number;
}

export interface GameRecord {
  id: string;
  startedAt: string;
  endedAt: string;
  gameMode: string;
  champion: string;
  role?: Role;
  /** The live API does not always report the result; null when unknown. */
  win: boolean | null;
  durationSeconds: number;
  kills: number;
  deaths: number;
  assists: number;
  cs: number;
  csPerMin: number;
  csAt10: number | null;
  csAt15: number | null;
  csDiffAt10: number | null;
  deathsBefore10: number;
  laneOpponent: string | null;
  samples: TimelineSample[];
}

export interface MetricSummary {
  label: string;
  value: number;
  /** Where the player should be; used to colour the UI and rank focus areas. */
  target: number;
  /** True when a higher number is better. */
  higherIsBetter: boolean;
  unit: string;
  /** Change vs. the older half of the window; null when there is too little data. */
  trend: number | null;
}

export interface TrendReport {
  gamesAnalyzed: number;
  metrics: MetricSummary[];
  /** Ranked worst-first, the things worth practising. */
  focusAreas: string[];
  championBreakdown: Array<{
    champion: string;
    games: number;
    wins: number;
    winRate: number;
    avgKda: number;
    avgCsPerMin: number;
  }>;
}
