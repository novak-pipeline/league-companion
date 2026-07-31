import type {
  Cue,
  DataSourceStatus,
  DraftAdvice,
  DraftState,
  GameRecord,
  GameSnapshot,
  Lane,
  ManualTimer,
  Role,
  TrendReport,
} from '../core/types.js';
import type { TrendTargets } from '../core/tracking/trends.js';
import type { OverlayDensity } from '../core/cues.js';

/**
 * The main <-> renderer contract.
 *
 * Both windows receive the same `CompanionState` and render a subset of it. The
 * main process owns all I/O and all timers; renderers are pure views plus
 * command dispatch. Keep this file in sync on both sides — it is the only thing
 * the preload bridge exposes.
 */

export type ConnectionMode = 'idle' | 'live' | 'demo';

export interface OverlaySettings {
  enabled: boolean;
  /** 0-1. */
  opacity: number;
  scale: number;
  /** Cue kinds the user has switched off. */
  mutedKinds: string[];
  /** How far ahead cues appear, in seconds. */
  horizonSeconds: number;
  /** When false the overlay ignores clicks entirely. */
  interactive: boolean;
  /** How much the overlay shows at once. See `applyDensity` in core/cues.ts. */
  density: OverlayDensity;
}

export interface RiotSettings {
  /**
   * Present only in the main process. The renderer receives `hasApiKey`
   * instead — the key never crosses the IPC boundary.
   */
  apiKey?: string;
  platform: string;
  /** Full Riot ID, e.g. "Faker#KR1". */
  riotId: string;
}

export interface MetaSettings {
  /** Collect meta samples in the background while the app is open. */
  autoCollect: boolean;
  /** Matches to pull per collection pass. */
  matchBudgetPerRun: number;
  /** Ladder players to seed each pass from. */
  seedPlayers: number;
}

export interface AppSettings {
  lane: Lane;
  role: Role;
  overlay: OverlaySettings;
  riot: RiotSettings;
  meta: MetaSettings;
  championPool: string[];
  targets: TrendTargets;
  /** Extra lockfile locations for non-standard League installs. */
  lockfilePaths: string[];
  /**
   * Seconds to add to (or subtract from) the built-in wave travel estimate.
   *
   * How long a wave takes to reach lane is the least certain number in the
   * patch config and the one the cannon countdown depends on most. Rather than
   * present an estimate as fact, the user can watch one game, see how far off
   * the countdown lands, and dial it in.
   */
  waveArrivalOffsetSeconds: number;
}

/** Settings as the renderer sees them: secrets replaced by presence flags. */
export type SafeSettings = Omit<AppSettings, 'riot'> & {
  riot: Omit<RiotSettings, 'apiKey'> & { hasApiKey: boolean };
};

export interface DataJobStatus {
  /** Which long-running job is active, if any. */
  job: 'meta' | 'history' | 'ddragon' | null;
  message: string;
  done: number;
  total: number;
}

export interface CompanionState {
  mode: ConnectionMode;
  snapshot: GameSnapshot | null;
  /** Full cue list, for the companion window. */
  cues: Cue[];
  /**
   * The same cues reduced to the overlay's density setting. Computed in the
   * main process so both windows agree and the renderer holds no cue logic.
   */
  overlayCues: Cue[];
  manualTimers: ManualTimer[];
  draft: DraftState | null;
  draftAdvice: DraftAdvice | null;
  history: GameRecord[];
  trends: TrendReport;
  dataStatus: DataSourceStatus;
  settings: SafeSettings;
  jobStatus: DataJobStatus;
  /** Non-fatal problems worth showing the user, e.g. an expired API key. */
  notices: string[];
  /** Which timing config is loaded, and which of its values are unverified. */
  patchInfo: { label: string; caveats: Array<{ field: string; note: string }> };
}

/** Commands the renderer can issue. */
export interface CompanionCommands {
  'settings:update': (patch: Partial<AppSettings>) => Promise<SafeSettings>;
  'timer:start': (timer: Omit<ManualTimer, 'id'>) => Promise<void>;
  'timer:clear': (id: string) => Promise<void>;
  'timer:clearAll': () => Promise<void>;
  'demo:toggle': (enabled: boolean) => Promise<void>;
  'demo:seek': (gameTime: number) => Promise<void>;
  'data:refreshDDragon': () => Promise<void>;
  'data:collectMeta': () => Promise<void>;
  'data:importHistory': (count: number) => Promise<number>;
  'data:verifyKey': () => Promise<boolean>;
  'overlay:setInteractive': (interactive: boolean) => Promise<void>;
  'draft:setManual': (draft: DraftState | null) => Promise<void>;
  'app:openCompanion': () => Promise<void>;
}

export type CommandName = keyof CompanionCommands;

export const IPC_CHANNELS = {
  /** Main -> renderer, full state push. */
  stateUpdate: 'companion:state',
  /** Renderer -> main, one channel with a discriminated command name. */
  command: 'companion:command',
} as const;

/** Shape exposed on `window.companion` by the preload bridge. */
export interface CompanionBridge {
  onState(handler: (state: CompanionState) => void): () => void;
  send<K extends CommandName>(
    name: K,
    ...args: Parameters<CompanionCommands[K]>
  ): ReturnType<CompanionCommands[K]>;
  /** Which window this renderer is, so one bundle can serve both. */
  windowKind: 'overlay' | 'companion';
}
