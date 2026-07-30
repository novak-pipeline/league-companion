import https from 'node:https';
import { EventEmitter } from 'node:events';
import type { GameSnapshot } from '../core/types.js';
import { normalizeGameData, type RawAllGameData } from './normalize.js';

/**
 * Riot's Live Client Data API client.
 *
 * The game serves this on loopback while a match is running. It is the
 * documented, Vanguard-safe way to read live game state: no memory reading, no
 * injection, no packet capture — just an HTTP GET against your own machine.
 *
 * https://developer.riotgames.com/docs/lol#game-client-api
 */

const HOST = '127.0.0.1';
const PORT = 2999;
const ENDPOINT = '/liveclientdata/allgamedata';

/**
 * The game serves this endpoint with a self-signed certificate for
 * "LoL Game Client". Riot publishes the root cert, but shipping and rotating it
 * is more failure-prone than skipping verification on a loopback-only agent:
 * this agent is used for 127.0.0.1 exclusively, where there is no network path
 * for a man-in-the-middle. It is never used for outbound requests.
 */
const loopbackAgent = new https.Agent({
  rejectUnauthorized: false,
  keepAlive: true,
  maxSockets: 2,
});

export interface LiveClientEvents {
  snapshot: (snapshot: GameSnapshot) => void;
  /** Emitted when a game starts (first successful poll after a gap). */
  gameStarted: () => void;
  /** Emitted when polling starts failing after a game was live. */
  gameEnded: (last: GameSnapshot | null) => void;
  error: (error: Error) => void;
}

export function fetchAllGameData(timeoutMs = 2000): Promise<RawAllGameData> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      { host: HOST, port: PORT, path: ENDPOINT, agent: loopbackAgent, timeout: timeoutMs },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`live client returned ${res.statusCode}`));
          return;
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(body) as RawAllGameData);
          } catch {
            reject(new Error('live client returned malformed JSON'));
          }
        });
      },
    );

    req.on('timeout', () => req.destroy(new Error('live client timed out')));
    req.on('error', reject);
  });
}

/**
 * Polls the live API and emits normalized snapshots.
 *
 * Connection failures are the normal state (there is no game running most of
 * the time), so they are not treated as errors — the poller just keeps trying.
 */
export class LiveClientPoller extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
  private isLive = false;
  private lastSnapshot: GameSnapshot | null = null;

  constructor(private readonly intervalMs = 1000) {
    super();
  }

  start(): void {
    if (this.timer) return;
    const tick = async () => {
      try {
        const raw = await fetchAllGameData();
        const snapshot = normalizeGameData(raw);
        if (!this.isLive) {
          this.isLive = true;
          this.emit('gameStarted');
        }
        this.lastSnapshot = snapshot;
        this.emit('snapshot', snapshot);
      } catch {
        // No game running, or the client is still loading. Both are expected.
        if (this.isLive) {
          this.isLive = false;
          this.emit('gameEnded', this.lastSnapshot);
          this.lastSnapshot = null;
        }
      }
    };
    void tick();
    this.timer = setInterval(() => void tick(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.isLive = false;
  }

  get live(): boolean {
    return this.isLive;
  }
}
