import type { GameRecord, GameSnapshot, PlayerState, Role, TimelineSample } from '../types.js';

/**
 * Per-game metric extraction.
 *
 * The live API only ever reports the *current* state, so benchmarks like CS@10
 * have to be captured as the game runs. `GameTracker` accumulates samples from
 * the poll loop; `finalizeGame` turns them into a stored record.
 */

/** Sample at most this often, to keep a 40-minute game's record small. */
export const SAMPLE_INTERVAL_SECONDS = 15;

/**
 * Finds the enemy laner to compare against.
 *
 * Riot reports `position` only in queues that have assigned roles, so this
 * falls back to matching the local player's role, and gives up rather than
 * guessing when it cannot tell.
 */
export function findLaneOpponent(snapshot: GameSnapshot): PlayerState | null {
  const { self, selfTeam } = snapshot;
  if (!self || !selfTeam) return null;
  const enemies = snapshot.players.filter((p) => p.team !== selfTeam);
  if (enemies.length === 0) return null;

  if (self.position) {
    const match = enemies.find((p) => p.position === self.position);
    if (match) return match;
  }
  return null;
}

export class GameTracker {
  private samples: TimelineSample[] = [];
  private deathsBefore10 = 0;
  private lastDeathCount = 0;
  private lastSampleTime = -Infinity;
  private startedAt: string;
  private lastSnapshot: GameSnapshot | null = null;

  constructor(private readonly now: () => Date = () => new Date()) {
    this.startedAt = this.now().toISOString();
  }

  /** Feeds a poll into the tracker. Safe to call at any rate. */
  observe(snapshot: GameSnapshot): void {
    const { self } = snapshot;
    if (!self) return;
    this.lastSnapshot = snapshot;

    // Deaths are cumulative in the API, so count the increments.
    if (self.deaths > this.lastDeathCount) {
      const newDeaths = self.deaths - this.lastDeathCount;
      if (snapshot.gameTime < 600) this.deathsBefore10 += newDeaths;
      this.lastDeathCount = self.deaths;
    }

    if (snapshot.gameTime - this.lastSampleTime < SAMPLE_INTERVAL_SECONDS) return;
    this.lastSampleTime = snapshot.gameTime;

    const opponent = findLaneOpponent(snapshot);
    this.samples.push({
      gameTime: snapshot.gameTime,
      cs: self.creepScore,
      kills: self.kills,
      deaths: self.deaths,
      assists: self.assists,
      level: self.level,
      ...(opponent ? { opponentCs: opponent.creepScore } : {}),
    });
  }

  getSamples(): TimelineSample[] {
    return [...this.samples];
  }

  /** The sample closest to `atSeconds` without going past it. */
  private sampleAt(atSeconds: number): TimelineSample | null {
    let best: TimelineSample | null = null;
    for (const s of this.samples) {
      if (s.gameTime > atSeconds + SAMPLE_INTERVAL_SECONDS) break;
      if (s.gameTime <= atSeconds + SAMPLE_INTERVAL_SECONDS) best = s;
    }
    // Do not report a benchmark the game never reached.
    if (!best || best.gameTime < atSeconds - SAMPLE_INTERVAL_SECONDS * 2) return null;
    return best;
  }

  /**
   * Builds the stored record. `win` is passed in because the live API does not
   * reliably report the result — the caller supplies it if it knows.
   */
  finalize(win: boolean | null = null, id?: string): GameRecord | null {
    const snapshot = this.lastSnapshot;
    const self = snapshot?.self;
    if (!snapshot || !self) return null;

    const at10 = this.sampleAt(600);
    const at15 = this.sampleAt(900);
    const minutes = snapshot.gameTime / 60;
    const opponent = findLaneOpponent(snapshot);

    return {
      id: id ?? `${this.startedAt}-${self.championName}`,
      startedAt: this.startedAt,
      endedAt: this.now().toISOString(),
      gameMode: snapshot.gameMode,
      champion: self.championName,
      ...(self.position ? { role: self.position as Role } : {}),
      win,
      durationSeconds: Math.round(snapshot.gameTime),
      kills: self.kills,
      deaths: self.deaths,
      assists: self.assists,
      cs: self.creepScore,
      csPerMin: minutes > 0 ? Number((self.creepScore / minutes).toFixed(1)) : 0,
      csAt10: at10?.cs ?? null,
      csAt15: at15?.cs ?? null,
      csDiffAt10: at10 && at10.opponentCs !== undefined ? at10.cs - at10.opponentCs : null,
      deathsBefore10: this.deathsBefore10,
      laneOpponent: opponent?.championName ?? null,
      samples: this.getSamples(),
    };
  }
}

/** KDA with the usual "perfect KDA" handling for zero deaths. */
export function kda(record: Pick<GameRecord, 'kills' | 'deaths' | 'assists'>): number {
  const denominator = record.deaths === 0 ? 1 : record.deaths;
  return Number(((record.kills + record.assists) / denominator).toFixed(2));
}
