import { EventEmitter } from 'node:events';
import type { GameEventRecord, GameSnapshot, PlayerState, Team } from '../core/types.js';

/**
 * Demo mode: a synthetic game that drives the whole app without League running.
 *
 * This exists so the overlay, timers, and tracker can be developed and verified
 * end-to-end, and so a first-time user can see what the app does before they
 * ever queue up. It emits the same `GameSnapshot` shape as the real poller, so
 * nothing downstream can tell the difference.
 */

const CHAMPIONS: Array<{ champ: string; team: Team; position: PlayerState['position'] }> = [
  { champ: 'Ahri', team: 'ORDER', position: 'mid' },
  { champ: 'LeeSin', team: 'ORDER', position: 'jungle' },
  { champ: 'Aatrox', team: 'ORDER', position: 'top' },
  { champ: 'Jinx', team: 'ORDER', position: 'adc' },
  { champ: 'Thresh', team: 'ORDER', position: 'support' },
  { champ: 'Syndra', team: 'CHAOS', position: 'mid' },
  { champ: 'Viego', team: 'CHAOS', position: 'jungle' },
  { champ: 'Ornn', team: 'CHAOS', position: 'top' },
  { champ: 'Caitlyn', team: 'CHAOS', position: 'adc' },
  { champ: 'Leona', team: 'CHAOS', position: 'support' },
];

/** Scripted events so objective timers have something real to react to. */
const SCRIPTED: Array<{ at: number; event: Omit<GameEventRecord, 'id'> }> = [
  { at: 330, event: { kind: 'DragonKill', gameTime: 330, killer: 'Player1', subtype: 'Fire' } },
  { at: 395, event: { kind: 'HordeKill', gameTime: 395, killer: 'Player1' } },
  { at: 640, event: { kind: 'DragonKill', gameTime: 640, killer: 'Enemy2', subtype: 'Air' } },
  { at: 855, event: { kind: 'HeraldKill', gameTime: 855, killer: 'Player1' } },
  { at: 1520, event: { kind: 'BaronKill', gameTime: 1520, killer: 'Enemy2' } },
];

export interface MockGameOptions {
  /** Game seconds advanced per real second. 1 is real time. */
  speed: number;
  startTime: number;
  intervalMs: number;
}

export const DEFAULT_MOCK_OPTIONS: MockGameOptions = {
  speed: 4,
  startTime: 0,
  intervalMs: 500,
};

export class MockGame extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
  private gameTime: number;
  private readonly opts: MockGameOptions;

  constructor(options: Partial<MockGameOptions> = {}) {
    super();
    this.opts = { ...DEFAULT_MOCK_OPTIONS, ...options };
    this.gameTime = this.opts.startTime;
  }

  private buildPlayers(): PlayerState[] {
    return CHAMPIONS.map((c, i) => {
      const minutes = this.gameTime / 60;
      // Roughly plausible growth so tracked metrics look sane in demo mode.
      const csRate = c.position === 'support' ? 1.2 : c.position === 'jungle' ? 4.5 : 7.2;
      const jitter = ((i * 37) % 11) / 10;
      return {
        summonerName: c.team === 'ORDER' ? `Player${i + 1}` : `Enemy${i - 4}`,
        championName: c.champ,
        team: c.team,
        ...(c.position ? { position: c.position } : {}),
        level: Math.min(18, 1 + Math.floor(minutes * 0.75)),
        isDead: false,
        respawnTimer: 0,
        kills: Math.floor(minutes / 6 + jitter),
        deaths: Math.floor(minutes / 8 + jitter / 2),
        assists: Math.floor(minutes / 4),
        creepScore: Math.floor(minutes * (csRate + jitter * 0.3)),
        wardScore: Number((minutes * 0.6).toFixed(1)),
        items: [],
      };
    });
  }

  private buildSnapshot(): GameSnapshot {
    const players = this.buildPlayers();
    const events: GameEventRecord[] = SCRIPTED.filter((s) => s.at <= this.gameTime).map(
      (s, i) => ({ id: i + 1, ...s.event }),
    );

    return {
      gameTime: this.gameTime,
      gameMode: 'CLASSIC',
      mapName: "Summoner's Rift",
      self: players[0] ?? null,
      selfTeam: 'ORDER',
      players,
      events,
    };
  }

  start(): void {
    if (this.timer) return;
    this.emit('gameStarted');
    this.timer = setInterval(() => {
      this.gameTime += (this.opts.intervalMs / 1000) * this.opts.speed;
      this.emit('snapshot', this.buildSnapshot());
    }, this.opts.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.emit('gameEnded', this.buildSnapshot());
  }

  /** Jumps the clock, so a demo can skip to an interesting moment. */
  seek(gameTime: number): void {
    this.gameTime = Math.max(0, gameTime);
    this.emit('snapshot', this.buildSnapshot());
  }

  get live(): boolean {
    return this.timer !== null;
  }
}
