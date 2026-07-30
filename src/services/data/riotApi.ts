/**
 * Riot Games API client.
 *
 * Used for two things:
 *   1. The player's own real match history — far more accurate than sampling
 *      the live client, and it backfills games played before this app existed.
 *   2. Sampling ranked matches to build the local meta dataset (see
 *      metaCollector.ts).
 *
 * Requires a key from https://developer.riotgames.com. A personal development
 * key is free but expires every 24 hours and is rate limited to roughly
 * 20 req/s and 100 req per 2 minutes; the limiter below respects that.
 *
 * The key is a secret: it is read from settings, never logged, and never
 * included in error messages.
 */

export type RegionalRoute = 'americas' | 'europe' | 'asia' | 'sea';
export type PlatformRoute =
  | 'na1' | 'euw1' | 'eun1' | 'kr' | 'br1' | 'jp1' | 'la1' | 'la2' | 'oc1' | 'tr1' | 'ru' | 'me1';

/** Which regional cluster a platform's match data lives in. */
export const PLATFORM_TO_REGION: Record<PlatformRoute, RegionalRoute> = {
  na1: 'americas', br1: 'americas', la1: 'americas', la2: 'americas',
  euw1: 'europe', eun1: 'europe', tr1: 'europe', ru: 'europe', me1: 'europe',
  kr: 'asia', jp1: 'asia',
  oc1: 'sea',
};

export interface RiotAccount {
  puuid: string;
  gameName: string;
  tagLine: string;
}

export interface MatchParticipant {
  puuid: string;
  championName: string;
  championId: number;
  teamId: number;
  win: boolean;
  kills: number;
  deaths: number;
  assists: number;
  totalMinionsKilled: number;
  neutralMinionsKilled: number;
  visionScore: number;
  goldEarned: number;
  /** Riot's assigned position: TOP/JUNGLE/MIDDLE/BOTTOM/UTILITY. */
  teamPosition: string;
  champLevel: number;
}

export interface MatchDetail {
  metadata: { matchId: string; participants: string[] };
  info: {
    gameCreation: number;
    gameDuration: number;
    gameEndTimestamp?: number;
    gameMode: string;
    gameVersion: string;
    queueId: number;
    participants: MatchParticipant[];
  };
}

export interface TimelineParticipantFrame {
  participantId: number;
  minionsKilled: number;
  jungleMinionsKilled: number;
  level: number;
  totalGold: number;
  xp: number;
}

export interface TimelineFrame {
  /** Milliseconds since game start. */
  timestamp: number;
  participantFrames: Record<string, TimelineParticipantFrame>;
  events: Array<{
    type: string;
    timestamp: number;
    killerId?: number;
    victimId?: number;
    participantId?: number;
  }>;
}

export interface MatchTimeline {
  metadata: { matchId: string; participants: string[] };
  info: {
    frames: TimelineFrame[];
    participants: Array<{ participantId: number; puuid: string }>;
  };
}

export class RiotApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'RiotApiError';
  }
}

/**
 * Token-bucket limiter matching Riot's development-key limits.
 * Production keys are far higher; the ceiling is configurable for that reason.
 */
class RateLimiter {
  private timestamps: number[] = [];

  constructor(
    private readonly perSecond: number,
    private readonly perTwoMinutes: number,
  ) {}

  async take(): Promise<void> {
    for (;;) {
      const now = Date.now();
      this.timestamps = this.timestamps.filter((t) => now - t < 120_000);
      const lastSecond = this.timestamps.filter((t) => now - t < 1000).length;

      if (lastSecond < this.perSecond && this.timestamps.length < this.perTwoMinutes) {
        this.timestamps.push(now);
        return;
      }

      // Wait until the earliest blocking request ages out.
      const waitFor =
        lastSecond >= this.perSecond
          ? 1000 - (now - (this.timestamps.at(-this.perSecond) ?? now))
          : 120_000 - (now - (this.timestamps[0] ?? now));
      await new Promise((r) => setTimeout(r, Math.max(50, waitFor)));
    }
  }
}

export interface RiotApiOptions {
  apiKey: string;
  platform: PlatformRoute;
  perSecond?: number;
  perTwoMinutes?: number;
}

export class RiotApiClient {
  private readonly limiter: RateLimiter;
  private readonly platform: PlatformRoute;
  private readonly region: RegionalRoute;
  private readonly apiKey: string;

  constructor(opts: RiotApiOptions) {
    this.apiKey = opts.apiKey;
    this.platform = opts.platform;
    this.region = PLATFORM_TO_REGION[opts.platform];
    this.limiter = new RateLimiter(opts.perSecond ?? 18, opts.perTwoMinutes ?? 95);
  }

  private async get<T>(host: string, path: string): Promise<T> {
    await this.limiter.take();
    const res = await fetch(`https://${host}${path}`, {
      headers: { 'X-Riot-Token': this.apiKey },
    });

    if (res.status === 429) {
      // Honour Riot's own backoff instruction rather than guessing.
      const retryAfter = Number(res.headers.get('Retry-After') ?? '5');
      await new Promise((r) => setTimeout(r, (retryAfter + 1) * 1000));
      return this.get<T>(host, path);
    }

    if (!res.ok) {
      // Deliberately does not echo the path or key material.
      throw new RiotApiError(
        res.status === 403
          ? 'Riot API key rejected (expired or invalid)'
          : `Riot API request failed with ${res.status}`,
        res.status,
      );
    }

    return (await res.json()) as T;
  }

  /** Resolves a Riot ID ("Name#TAG") to an account. */
  async getAccount(gameName: string, tagLine: string): Promise<RiotAccount> {
    return this.get<RiotAccount>(
      `${this.region}.api.riotgames.com`,
      `/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`,
    );
  }

  /**
   * Recent match ids for a player.
   * `queue` 420 is ranked solo/duo, which is what climbing actually means.
   */
  async getMatchIds(
    puuid: string,
    opts: { count?: number; start?: number; queue?: number } = {},
  ): Promise<string[]> {
    const params = new URLSearchParams({
      count: String(opts.count ?? 20),
      start: String(opts.start ?? 0),
    });
    if (opts.queue !== undefined) params.set('queue', String(opts.queue));
    return this.get<string[]>(
      `${this.region}.api.riotgames.com`,
      `/lol/match/v5/matches/by-puuid/${puuid}/ids?${params}`,
    );
  }

  async getMatch(matchId: string): Promise<MatchDetail> {
    return this.get<MatchDetail>(
      `${this.region}.api.riotgames.com`,
      `/lol/match/v5/matches/${matchId}`,
    );
  }

  /**
   * Per-minute frames for a match. This is the only accurate source for
   * benchmarks like CS at 10 minutes — the live client API can only be sampled
   * as the game runs, and never covers games played before this app existed.
   */
  async getMatchTimeline(matchId: string): Promise<MatchTimeline> {
    return this.get<MatchTimeline>(
      `${this.region}.api.riotgames.com`,
      `/lol/match/v5/matches/${matchId}/timeline`,
    );
  }

  /** Top-of-ladder league entries, used as the seed for meta sampling. */
  async getChallengerLeague(queue = 'RANKED_SOLO_5x5'): Promise<{ entries: Array<{ puuid?: string; summonerId: string }> }> {
    return this.get(
      `${this.platform}.api.riotgames.com`,
      `/lol/league/v1/challengerleagues/by-queue/${queue}`,
    );
  }

  /** Cheap call used to check whether a key is currently valid. */
  async verifyKey(): Promise<boolean> {
    try {
      await this.getChallengerLeague();
      return true;
    } catch {
      return false;
    }
  }
}

/** Riot's patch strings are "26.14.567.1234"; the meta only cares about "26.14". */
export function shortPatch(gameVersion: string): string {
  const parts = gameVersion.split('.');
  return parts.length >= 2 ? `${parts[0]}.${parts[1]}` : gameVersion;
}
