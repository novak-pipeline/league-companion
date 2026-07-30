import https from 'node:https';
import { readFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import type { DraftPick, DraftState, Role } from '../core/types.js';
import { registry } from '../core/draft/registry.js';

/**
 * League Client Update (LCU) API — the desktop client's own local API.
 *
 * This is what makes the draft assistant possible: champ select state is not in
 * the in-game Live Client API, it lives in the client. Access is via a lockfile
 * the client writes on launch containing the port and a per-session password.
 *
 * Like the Live Client API this is loopback-only and read-only here. The app
 * never sends actions (no auto-pick, no auto-accept) — automating the client is
 * against Riot's third-party policy even though the endpoint would allow it.
 */

interface Lockfile {
  port: number;
  password: string;
  protocol: string;
}

/** Default install locations by platform. */
const LOCKFILE_PATHS: string[] = [
  'C:\\Riot Games\\League of Legends\\lockfile',
  'C:\\Program Files\\Riot Games\\League of Legends\\lockfile',
  '/Applications/League of Legends.app/Contents/LoL/lockfile',
  `${process.env.HOME ?? ''}/Applications/League of Legends.app/Contents/LoL/lockfile`,
];

export function findLockfilePath(extraPaths: string[] = []): string | null {
  for (const path of [...extraPaths, ...LOCKFILE_PATHS]) {
    if (path && existsSync(path)) return path;
  }
  return null;
}

/** Lockfile format: `LeagueClient:PID:PORT:PASSWORD:PROTOCOL`. */
export function parseLockfile(contents: string): Lockfile | null {
  const parts = contents.trim().split(':');
  if (parts.length < 5) return null;
  const port = Number(parts[2]);
  const password = parts[3];
  const protocol = parts[4];
  if (!Number.isFinite(port) || !password || !protocol) return null;
  return { port, password, protocol };
}

export async function readLockfile(extraPaths: string[] = []): Promise<Lockfile | null> {
  const path = findLockfilePath(extraPaths);
  if (!path) return null;
  try {
    return parseLockfile(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

// The client uses a self-signed certificate on loopback; same reasoning as the
// live client agent in liveClient.ts.
const loopbackAgent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });

function lcuGet<T>(lock: Lockfile, path: string, timeoutMs = 2000): Promise<T> {
  return new Promise((resolve, reject) => {
    const auth = Buffer.from(`riot:${lock.password}`).toString('base64');
    const req = https.get(
      {
        host: '127.0.0.1',
        port: lock.port,
        path,
        agent: loopbackAgent,
        timeout: timeoutMs,
        headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`LCU returned ${res.statusCode}`));
          return;
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(body) as T);
          } catch {
            reject(new Error('LCU returned malformed JSON'));
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('LCU timed out')));
    req.on('error', reject);
  });
}

// --- Champ select shapes (only what we read) -------------------------------

interface ChampSelectPlayer {
  cellId: number;
  championId: number;
  championPickIntent: number;
  assignedPosition: string;
}

interface ChampSelectAction {
  actorCellId: number;
  championId: number;
  completed: boolean;
  isAllyAction: boolean;
  type: string;
}

interface ChampSelectSession {
  actions: ChampSelectAction[][];
  localPlayerCellId: number;
  myTeam: ChampSelectPlayer[];
  theirTeam: ChampSelectPlayer[];
  bans?: { myTeamBans?: number[]; theirTeamBans?: number[] };
}

const POSITION_MAP: Record<string, Role> = {
  top: 'top',
  jungle: 'jungle',
  middle: 'mid',
  bottom: 'adc',
  utility: 'support',
};

/**
 * Converts a champ select session into our draft state.
 *
 * `championId` is 0 until a player locks in, and `championPickIntent` carries
 * the hover, so hovers are shown too — that is when advice is actually useful.
 */
export function toDraftState(session: ChampSelectSession): DraftState {
  const resolve = (numericId: number): string | null => {
    if (!numericId) return null;
    return registry.getByNumericKey(numericId)?.id ?? null;
  };

  const mapTeam = (team: ChampSelectPlayer[]): DraftPick[] =>
    team
      .map((p) => {
        const id = resolve(p.championId) ?? resolve(p.championPickIntent);
        if (!id) return null;
        const role = POSITION_MAP[p.assignedPosition?.toLowerCase() ?? ''];
        return { championId: id, ...(role ? { role } : {}) } satisfies DraftPick;
      })
      .filter((p): p is DraftPick => p !== null);

  const me = session.myTeam.find((p) => p.cellId === session.localPlayerCellId);
  const myRole = me ? POSITION_MAP[me.assignedPosition?.toLowerCase() ?? ''] : undefined;

  // It is my turn when an incomplete pick action belongs to my cell.
  const isMyTurn = session.actions
    .flat()
    .some((a) => a.actorCellId === session.localPlayerCellId && a.type === 'pick' && !a.completed);

  const bans = [
    ...(session.bans?.myTeamBans ?? []),
    ...(session.bans?.theirTeamBans ?? []),
  ]
    .map(resolve)
    .filter((id): id is string => id !== null);

  return {
    allies: mapTeam(session.myTeam),
    enemies: mapTeam(session.theirTeam),
    bans,
    ...(myRole ? { myRole } : {}),
    isMyTurn,
  };
}

/**
 * Polls champ select and emits draft state.
 *
 * Emits `draft` while champ select is active and `draftEnded` when it closes.
 * A missing lockfile just means the client is not running.
 */
export class ChampSelectPoller extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
  private inChampSelect = false;

  constructor(
    private readonly intervalMs = 1500,
    private readonly extraLockfilePaths: string[] = [],
  ) {
    super();
  }

  start(): void {
    if (this.timer) return;
    const tick = async () => {
      const lock = await readLockfile(this.extraLockfilePaths);
      if (!lock) {
        this.endIfActive();
        return;
      }
      try {
        const session = await lcuGet<ChampSelectSession>(lock, '/lol-champ-select/v1/session');
        this.inChampSelect = true;
        this.emit('draft', toDraftState(session));
      } catch {
        // A 404 here is the normal "not in champ select" response.
        this.endIfActive();
      }
    };
    void tick();
    this.timer = setInterval(() => void tick(), this.intervalMs);
  }

  private endIfActive(): void {
    if (this.inChampSelect) {
      this.inChampSelect = false;
      this.emit('draftEnded');
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.inChampSelect = false;
  }
}
