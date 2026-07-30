import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { GameRecord } from '../core/types.js';
import type { AppSettings, SafeSettings } from '../shared/ipc.js';
import { DEFAULT_TARGETS } from '../core/tracking/trends.js';

/**
 * Persistence for settings and match history.
 *
 * Plain JSON on disk — the data is small (a few thousand games at most) and
 * keeping it human-readable means a user can inspect or hand-edit it. Writes go
 * through a temp file and rename so a crash mid-write cannot corrupt the store.
 */

export const DEFAULT_SETTINGS: AppSettings = {
  lane: 'mid',
  role: 'mid',
  overlay: {
    enabled: true,
    opacity: 0.95,
    scale: 1,
    mutedKinds: [],
    // Deliberately tight: a cue that appears two minutes early is a clock, not
    // a prompt, and the player learns to ignore it.
    horizonSeconds: 45,
    interactive: false,
    density: 'normal',
  },
  riot: {
    platform: 'na1',
    riotId: '',
  },
  meta: {
    autoCollect: false,
    matchBudgetPerRun: 50,
    seedPlayers: 20,
  },
  championPool: [],
  targets: DEFAULT_TARGETS,
  lockfilePaths: [],
};

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await rename(tmp, file);
}

export class Store {
  private settings: AppSettings = { ...DEFAULT_SETTINGS };
  private history: GameRecord[] = [];

  constructor(private readonly dataDir: string) {}

  private get settingsFile(): string {
    return join(this.dataDir, 'settings.json');
  }

  private get historyFile(): string {
    return join(this.dataDir, 'history.json');
  }

  async load(): Promise<void> {
    const settings = await readJson<Partial<AppSettings>>(this.settingsFile);
    if (settings) {
      // Merge rather than replace so new settings keys get their defaults when
      // upgrading from an older version of the app.
      this.settings = {
        ...DEFAULT_SETTINGS,
        ...settings,
        overlay: { ...DEFAULT_SETTINGS.overlay, ...settings.overlay },
        riot: { ...DEFAULT_SETTINGS.riot, ...settings.riot },
        meta: { ...DEFAULT_SETTINGS.meta, ...settings.meta },
        targets: { ...DEFAULT_SETTINGS.targets, ...settings.targets },
      };
    }
    this.history = (await readJson<GameRecord[]>(this.historyFile)) ?? [];
  }

  getSettings(): AppSettings {
    return this.settings;
  }

  /** Settings with the API key stripped, for sending to renderers. */
  getSafeSettings(): SafeSettings {
    const { riot, ...rest } = this.settings;
    const { apiKey, ...safeRiot } = riot;
    return { ...rest, riot: { ...safeRiot, hasApiKey: Boolean(apiKey) } };
  }

  async updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
    this.settings = {
      ...this.settings,
      ...patch,
      overlay: { ...this.settings.overlay, ...patch.overlay },
      // An absent or blank apiKey in the patch must not wipe a stored key —
      // the renderer sends the riot block back without it on every edit.
      riot: {
        ...this.settings.riot,
        ...patch.riot,
        apiKey: patch.riot?.apiKey?.trim() ? patch.riot.apiKey.trim() : this.settings.riot.apiKey,
      },
      meta: { ...this.settings.meta, ...patch.meta },
      targets: { ...this.settings.targets, ...patch.targets },
    };
    await writeJsonAtomic(this.settingsFile, this.settings);
    return this.settings;
  }

  getHistory(): GameRecord[] {
    return this.history;
  }

  /** Adds records, replacing any with a matching id, newest first. */
  async addGames(records: GameRecord[]): Promise<number> {
    if (records.length === 0) return 0;
    const byId = new Map(this.history.map((g) => [g.id, g]));
    let added = 0;
    for (const record of records) {
      if (!byId.has(record.id)) added += 1;
      byId.set(record.id, record);
    }
    this.history = [...byId.values()].sort((a, b) => b.endedAt.localeCompare(a.endedAt));
    await writeJsonAtomic(this.historyFile, this.history);
    return added;
  }
}
