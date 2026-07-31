import { app, BrowserWindow, ipcMain, session } from 'electron';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import type {
  Cue,
  DataSourceStatus,
  DraftAdvice,
  DraftState,
  GameSnapshot,
  ManualTimer,
} from '../core/types.js';
import type { AppSettings, CompanionState, DataJobStatus } from '../shared/ipc.js';

import { applyDensity, buildCues } from '../core/cues.js';
import { DEFAULT_PATCH } from '../core/patch.js';
import { analyzeDraft } from '../core/draft/advice.js';
import { registry } from '../core/draft/registry.js';
import { analyzeTrends } from '../core/tracking/trends.js';
import { GameTracker } from '../core/tracking/metrics.js';

import { Store } from './store.js';
import { createCompanionWindow, createOverlayWindow, setOverlayInteractive } from './windows.js';

import { LiveClientPoller } from '../services/liveClient.js';
import { ChampSelectPoller } from '../services/lcu.js';
import { MockGame } from '../services/mockGame.js';
import { JsonCache } from '../services/data/cache.js';
import { loadDDragon } from '../services/data/ddragon.js';
import { collectMeta, loadMeta } from '../services/data/metaCollector.js';
import { importRecentMatches, resolveAccount } from '../services/data/matchImport.js';
import { RiotApiClient, type PlatformRoute } from '../services/data/riotApi.js';

/**
 * Application orchestrator.
 *
 * Owns every piece of I/O and all mutable state. Both renderers are pure views:
 * this process polls, computes, and pushes a complete `CompanionState` to them.
 */

const dataDir = join(app.getPath('userData'), 'data');
const store = new Store(dataDir);
const cache = new JsonCache(join(dataDir, 'cache'));

let overlayWindow: BrowserWindow | null = null;
let companionWindow: BrowserWindow | null = null;

const livePoller = new LiveClientPoller(1000);
const champSelectPoller = new ChampSelectPoller(1500);
let mockGame: MockGame | null = null;
let tracker: GameTracker | null = null;

// --- Mutable app state ------------------------------------------------------
let mode: CompanionState['mode'] = 'idle';
let snapshot: GameSnapshot | null = null;
let manualTimers: ManualTimer[] = [];
let draft: DraftState | null = null;
let draftAdvice: DraftAdvice | null = null;
let jobStatus: DataJobStatus = { job: null, message: '', done: 0, total: 0 };
let notices: string[] = [];
let riotApiError: string | null = null;

function buildDataStatus(): DataSourceStatus {
  const meta = registry.getMetaSnapshot();
  const settings = store.getSettings();
  return {
    ddragon: {
      patch: registry.getDDragonVersion(),
      championCount: registry.all().length,
      updatedAt: null,
      ok: registry.hasNumericKeys(),
    },
    meta: {
      patch: meta?.patch ?? null,
      sampleSize: meta?.sampleSize ?? 0,
      updatedAt: meta?.updatedAt ?? null,
      source: meta?.source ?? 'none',
    },
    riotApi: { configured: Boolean(settings.riot.apiKey), lastError: riotApiError },
    personalMatches: store.getHistory().length,
  };
}

/**
 * The patch config with the user's wave-arrival calibration folded in.
 *
 * Travel time is the least certain value in the config, so the offset is
 * applied here rather than baked into the defaults — the shipped estimate stays
 * honest and the user's correction sits on top of it.
 */
function activePatch(): typeof DEFAULT_PATCH {
  const offset = store.getSettings().waveArrivalOffsetSeconds;
  if (!offset) return DEFAULT_PATCH;
  const adjust = (value: number) => Math.max(0, value + offset);
  return {
    ...DEFAULT_PATCH,
    laneTravelSeconds: {
      top: adjust(DEFAULT_PATCH.laneTravelSeconds.top),
      mid: adjust(DEFAULT_PATCH.laneTravelSeconds.mid),
      bot: adjust(DEFAULT_PATCH.laneTravelSeconds.bot),
    },
  };
}

function currentCues(): Cue[] {
  if (!snapshot) return [];
  const settings = store.getSettings();
  // The full list is built unmuted for the companion window; the overlay's
  // muting is applied separately in buildState so the two windows can differ.
  return buildCues(snapshot, manualTimers, {
    lane: settings.lane,
    patch: activePatch(),
    horizonSeconds: settings.overlay.horizonSeconds,
    mutedKinds: [],
    history: store.getHistory(),
  });
}

function buildState(): CompanionState {
  const settings = store.getSettings();
  const cues = currentCues();
  const overlayCues = applyDensity(
    cues.filter((c) => !settings.overlay.mutedKinds.includes(c.kind)),
    settings.overlay.density,
  );
  return {
    mode,
    snapshot,
    cues,
    overlayCues,
    manualTimers,
    draft,
    draftAdvice,
    history: store.getHistory(),
    trends: analyzeTrends(store.getHistory(), 20, settings.targets),
    dataStatus: buildDataStatus(),
    settings: store.getSafeSettings(),
    jobStatus,
    notices,
    patchInfo: { label: DEFAULT_PATCH.label, caveats: DEFAULT_PATCH.caveats },
  };
}

function broadcast(): void {
  const state = buildState();
  for (const win of [overlayWindow, companionWindow]) {
    if (win && !win.isDestroyed()) win.webContents.send('companion:state', state);
  }
}

function setJob(job: DataJobStatus['job'], message: string, done = 0, total = 0): void {
  jobStatus = { job, message, done, total };
  broadcast();
}

function addNotice(message: string): void {
  if (!notices.includes(message)) notices = [...notices, message];
}

// --- Riot API helper --------------------------------------------------------

function makeRiotClient(): RiotApiClient | null {
  const { riot } = store.getSettings();
  if (!riot.apiKey) return null;
  return new RiotApiClient({
    apiKey: riot.apiKey,
    platform: (riot.platform || 'na1') as PlatformRoute,
  });
}

async function resolvePuuid(client: RiotApiClient): Promise<string | null> {
  const { riotId } = store.getSettings().riot;
  const [gameName, tagLine] = riotId.split('#');
  if (!gameName || !tagLine) {
    addNotice('Set your Riot ID as "Name#TAG" in the Data tab to import matches.');
    return null;
  }
  const account = await resolveAccount(client, cache, gameName, tagLine);
  return account?.puuid ?? null;
}

// --- Data hydration ---------------------------------------------------------

async function hydrateChampionData(): Promise<void> {
  setJob('ddragon', 'Loading champion data…');
  const ddragon = await loadDDragon(cache);
  if (ddragon) {
    registry.applyDDragon(ddragon);
    const meta = await loadMeta(cache, ddragon.version.split('.').slice(0, 2).join('.'));
    if (meta) registry.applyMeta(meta);
  } else {
    addNotice(
      'Could not reach Data Dragon. Using the bundled champion table — draft data may be a patch behind.',
    );
  }
  setJob(null, '');
}

// --- Game loop wiring -------------------------------------------------------

function handleSnapshot(next: GameSnapshot): void {
  snapshot = next;
  tracker ??= new GameTracker();
  tracker.observe(next);
  broadcast();
}

async function handleGameEnded(): Promise<void> {
  const finished = tracker?.finalize(null);
  tracker = null;
  snapshot = null;
  manualTimers = [];
  mode = mockGame?.live ? 'demo' : 'idle';

  // The live client cannot tell us who won, so the record is provisional. When
  // an API key is configured the authoritative version is imported instead.
  if (finished) {
    const client = makeRiotClient();
    if (client) {
      void importHistory(20).catch(() => undefined);
    } else {
      await store.addGames([finished]);
    }
  }
  broadcast();
}

livePoller.on('gameStarted', () => {
  mode = 'live';
  tracker = new GameTracker();
  broadcast();
});
livePoller.on('snapshot', handleSnapshot);
livePoller.on('gameEnded', () => void handleGameEnded());

champSelectPoller.on('draft', (next: DraftState) => {
  draft = next;
  if (!registry.hasNumericKeys()) {
    addNotice('Champion data has not loaded yet, so champ select cannot be read. Refresh it in the Data tab.');
    broadcast();
    return;
  }
  const settings = store.getSettings();
  draftAdvice = analyzeDraft(next, {
    championPool: settings.championPool,
    history: store.getHistory(),
    registry,
  });
  broadcast();
});

champSelectPoller.on('draftEnded', () => {
  draft = null;
  draftAdvice = null;
  broadcast();
});

// --- Long-running jobs ------------------------------------------------------

async function importHistory(count: number): Promise<number> {
  const client = makeRiotClient();
  if (!client) {
    addNotice('Add a Riot API key in the Data tab to import your match history.');
    broadcast();
    return 0;
  }

  setJob('history', 'Importing match history…', 0, count);
  try {
    const puuid = await resolvePuuid(client);
    if (!puuid) return 0;

    const imported = await importRecentMatches(client, puuid, store.getHistory(), {
      count,
      includeTimelines: true,
      rankedOnly: true,
      onProgress: (done, total) => setJob('history', 'Importing match history…', done, total),
    });
    const added = await store.addGames(imported);
    riotApiError = null;
    return added;
  } catch (error) {
    riotApiError = error instanceof Error ? error.message : 'unknown error';
    addNotice(`Match import failed: ${riotApiError}`);
    return 0;
  } finally {
    setJob(null, '');
  }
}

async function runMetaCollection(): Promise<void> {
  const client = makeRiotClient();
  if (!client) {
    addNotice('Add a Riot API key in the Data tab to build the meta dataset.');
    broadcast();
    return;
  }

  const version = registry.getDDragonVersion();
  if (!version) {
    addNotice('Champion data must load before meta collection can start.');
    broadcast();
    return;
  }
  const patch = version.split('.').slice(0, 2).join('.');
  const settings = store.getSettings();

  setJob('meta', `Sampling ranked matches for patch ${patch}…`, 0, settings.meta.matchBudgetPerRun);
  try {
    const meta = await collectMeta(client, cache, patch, {
      matchBudget: settings.meta.matchBudgetPerRun,
      seedPlayers: settings.meta.seedPlayers,
      onProgress: (done, total) =>
        setJob('meta', `Sampling ranked matches for patch ${patch}…`, done, total),
    });
    registry.applyMeta(meta);
    riotApiError = null;
  } catch (error) {
    riotApiError = error instanceof Error ? error.message : 'unknown error';
    addNotice(`Meta collection failed: ${riotApiError}`);
  } finally {
    setJob(null, '');
  }
}

// --- Commands ---------------------------------------------------------------

const commands: Record<string, (args: unknown[]) => Promise<unknown>> = {
  'app:requestState': async () => {
    broadcast();
  },

  'settings:update': async ([patch]) => {
    const updated = await store.updateSettings(patch as Partial<AppSettings>);
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      setOverlayInteractive(overlayWindow, updated.overlay.interactive);
      if (updated.overlay.enabled) overlayWindow.showInactive();
      else overlayWindow.hide();
    }
    broadcast();
    return store.getSafeSettings();
  },

  'timer:start': async ([timer]) => {
    const input = timer as Omit<ManualTimer, 'id'>;
    manualTimers = [...manualTimers, { ...input, id: randomUUID() }];
    broadcast();
  },

  'timer:clear': async ([id]) => {
    manualTimers = manualTimers.filter((t) => t.id !== id);
    broadcast();
  },

  'timer:clearAll': async () => {
    manualTimers = [];
    broadcast();
  },

  'demo:toggle': async ([enabled]) => {
    if (enabled) {
      livePoller.stop();
      mockGame = new MockGame();
      mockGame.on('snapshot', handleSnapshot);
      mockGame.on('gameEnded', () => void handleGameEnded());
      tracker = new GameTracker();
      mode = 'demo';
      mockGame.start();
    } else {
      mockGame?.stop();
      mockGame = null;
      snapshot = null;
      mode = 'idle';
      livePoller.start();
    }
    broadcast();
  },

  'demo:seek': async ([gameTime]) => {
    mockGame?.seek(gameTime as number);
  },

  'data:refreshDDragon': async () => {
    await hydrateChampionData();
    broadcast();
  },

  'data:collectMeta': async () => {
    await runMetaCollection();
    broadcast();
  },

  'data:importHistory': async ([count]) => {
    const added = await importHistory((count as number) ?? 20);
    broadcast();
    return added;
  },

  'data:verifyKey': async () => {
    const client = makeRiotClient();
    if (!client) return false;
    const ok = await client.verifyKey();
    riotApiError = ok ? null : 'Key rejected';
    broadcast();
    return ok;
  },

  'overlay:setInteractive': async ([interactive]) => {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      setOverlayInteractive(overlayWindow, interactive as boolean);
    }
  },

  'draft:setManual': async ([next]) => {
    draft = next as DraftState | null;
    draftAdvice = draft
      ? analyzeDraft(draft, {
          championPool: store.getSettings().championPool,
          history: store.getHistory(),
          registry,
        })
      : null;
    broadcast();
  },

  'app:openCompanion': async () => {
    if (!companionWindow || companionWindow.isDestroyed()) {
      companionWindow = createCompanionWindow();
    } else {
      companionWindow.focus();
    }
  },
};

ipcMain.handle('companion:command', async (_event, name: string, args: unknown[]) => {
  const handler = commands[name];
  if (!handler) throw new Error(`unknown command: ${name}`);
  return handler(args ?? []);
});

// --- Lifecycle --------------------------------------------------------------

/**
 * Locks the renderers down to local content plus Riot's asset CDN.
 *
 * Applied in production only: the Vite dev server needs eval for hot reload, and
 * a CSP strict enough to be worth having would break it.
 */
function applyContentSecurityPolicy(): void {
  if (process.env.LC_DEV === '1') return;
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          [
            "default-src 'self'",
            "script-src 'self'",
            // React inlines component styles at runtime.
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data: https://ddragon.leagueoflegends.com",
            // All app I/O goes through the main process; renderers talk to nobody.
            "connect-src 'none'",
            "object-src 'none'",
            "frame-src 'none'",
          ].join('; '),
        ],
      },
    });
  });
}

async function bootstrap(): Promise<void> {
  applyContentSecurityPolicy();
  await store.load();

  companionWindow = createCompanionWindow();
  if (store.getSettings().overlay.enabled) {
    overlayWindow = createOverlayWindow();
  }

  // Champion data first: champ select cannot be read without it.
  await hydrateChampionData();

  livePoller.start();
  champSelectPoller.start();
  broadcast();

  if (store.getSettings().meta.autoCollect) {
    void runMetaCollection().then(broadcast);
  }
}

void app.whenReady().then(bootstrap);

app.on('window-all-closed', () => {
  livePoller.stop();
  champSelectPoller.stop();
  mockGame?.stop();
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) void bootstrap();
});
