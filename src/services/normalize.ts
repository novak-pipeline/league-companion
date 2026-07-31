import type {
  GameEventKind,
  GameEventRecord,
  GameSnapshot,
  PlayerState,
  Role,
  Team,
} from '../core/types.js';

/**
 * Translates Riot's Live Client Data API payloads into our domain types.
 *
 * Riot's shapes are PascalCase, loosely typed, and change between patches, so
 * everything here is defensive: unknown fields degrade to sensible defaults
 * rather than throwing and killing the poll loop.
 */

// Raw shapes (only the fields we consume).
interface RawScores {
  assists?: number;
  creepScore?: number;
  deaths?: number;
  kills?: number;
  wardScore?: number;
}

interface RawPlayer {
  championName?: string;
  isDead?: boolean;
  items?: Array<{ displayName?: string }>;
  level?: number;
  position?: string;
  respawnTimer?: number;
  scores?: RawScores;
  summonerName?: string;
  riotIdGameName?: string;
  team?: string;
}

interface RawEvent {
  EventID?: number;
  EventName?: string;
  EventTime?: number;
  DragonType?: string;
  KillerName?: string;
  VictimName?: string;
  Assisters?: string[];
  Stolen?: string;
}

export interface RawAllGameData {
  activePlayer?: { summonerName?: string; riotIdGameName?: string };
  allPlayers?: RawPlayer[];
  events?: { Events?: RawEvent[] };
  gameData?: { gameMode?: string; gameTime?: number; mapName?: string };
}

/** Riot's position strings differ from ours. */
const POSITION_MAP: Record<string, Role> = {
  TOP: 'top',
  JUNGLE: 'jungle',
  MIDDLE: 'mid',
  MID: 'mid',
  BOTTOM: 'adc',
  BOT: 'adc',
  UTILITY: 'support',
  SUPPORT: 'support',
};

const EVENT_MAP: Record<string, GameEventKind> = {
  GameStart: 'GameStart',
  MinionsSpawning: 'MinionsSpawning',
  FirstBlood: 'FirstBlood',
  ChampionKill: 'ChampionKill',
  Multikill: 'Multikill',
  Ace: 'Ace',
  TurretKilled: 'TurretKilled',
  FirstBrick: 'TurretKilled',
  InhibKilled: 'InhibKilled',
  DragonKill: 'DragonKill',
  HeraldKill: 'HeraldKill',
  BaronKill: 'BaronKill',
  HordeKill: 'HordeKill',
  // Note: no AtakhanKill. Atakhan was removed from Summoner's Rift in patch
  // 26.1, so the event cannot occur; an unrecognised name degrades to
  // 'Unknown' rather than breaking the poll loop.
};

function normalizeTeam(raw: string | undefined): Team {
  return raw === 'CHAOS' ? 'CHAOS' : 'ORDER';
}

export function normalizePlayer(raw: RawPlayer): PlayerState {
  const position = raw.position ? POSITION_MAP[raw.position.toUpperCase()] : undefined;
  return {
    // Riot IDs replaced summoner names; either field may be the populated one.
    summonerName: raw.riotIdGameName || raw.summonerName || 'Unknown',
    championName: raw.championName ?? 'Unknown',
    team: normalizeTeam(raw.team),
    ...(position ? { position } : {}),
    level: raw.level ?? 1,
    isDead: raw.isDead ?? false,
    respawnTimer: raw.respawnTimer ?? 0,
    kills: raw.scores?.kills ?? 0,
    deaths: raw.scores?.deaths ?? 0,
    assists: raw.scores?.assists ?? 0,
    creepScore: raw.scores?.creepScore ?? 0,
    wardScore: raw.scores?.wardScore ?? 0,
    items: (raw.items ?? []).map((i) => i.displayName ?? '').filter(Boolean),
  };
}

export function normalizeEvent(raw: RawEvent, fallbackId: number): GameEventRecord {
  const name = raw.EventName ?? '';
  return {
    id: raw.EventID ?? fallbackId,
    kind: EVENT_MAP[name] ?? 'Unknown',
    gameTime: raw.EventTime ?? 0,
    ...(raw.DragonType ? { subtype: raw.DragonType } : {}),
    ...(raw.KillerName ? { killer: raw.KillerName } : {}),
    ...(raw.VictimName ? { victim: raw.VictimName } : {}),
    ...(raw.Assisters?.length ? { assisters: raw.Assisters } : {}),
    ...(raw.Stolen ? { stolen: raw.Stolen === 'True' } : {}),
  };
}

export function normalizeGameData(raw: RawAllGameData): GameSnapshot {
  const players = (raw.allPlayers ?? []).map(normalizePlayer);
  const events = (raw.events?.Events ?? []).map(normalizeEvent);

  // The active player is identified by name only, so match on either the Riot
  // ID or the legacy summoner name.
  const activeName = raw.activePlayer?.riotIdGameName || raw.activePlayer?.summonerName || '';
  const bare = activeName.split('#')[0]?.trim().toLowerCase() ?? '';
  const self =
    players.find((p) => p.summonerName.toLowerCase() === bare) ??
    players.find((p) => p.summonerName.toLowerCase() === activeName.trim().toLowerCase()) ??
    null;

  return {
    gameTime: raw.gameData?.gameTime ?? 0,
    gameMode: raw.gameData?.gameMode ?? 'Unknown',
    mapName: raw.gameData?.mapName ?? 'Unknown',
    self,
    selfTeam: self?.team ?? null,
    players,
    events,
  };
}
