import { describe, expect, it } from 'vitest';
import { normalizeEvent, normalizeGameData, normalizePlayer } from '../src/services/normalize.js';
import { accumulateMatch, toSnapshot, type MetaState } from '../src/services/data/metaCollector.js';
import { csAtMinute, deathsBefore, toGameRecord } from '../src/services/data/matchImport.js';
import { deriveFromDDragon } from '../src/services/data/ddragon.js';
import { parseLockfile, toDraftState } from '../src/services/lcu.js';
import { shortPatch } from '../src/services/data/riotApi.js';
import type { MatchDetail, MatchTimeline } from '../src/services/data/riotApi.js';

describe('live client normalization', () => {
  it('maps Riot positions onto our roles', () => {
    expect(normalizePlayer({ position: 'MIDDLE' }).position).toBe('mid');
    expect(normalizePlayer({ position: 'UTILITY' }).position).toBe('support');
    expect(normalizePlayer({ position: 'BOTTOM' }).position).toBe('adc');
  });

  it('leaves position undefined when Riot reports none', () => {
    expect(normalizePlayer({ position: '' }).position).toBeUndefined();
  });

  it('defaults missing scores to zero rather than throwing', () => {
    const player = normalizePlayer({ championName: 'Ahri' });
    expect(player.kills).toBe(0);
    expect(player.creepScore).toBe(0);
    expect(player.championName).toBe('Ahri');
  });

  it('prefers the Riot ID over the legacy summoner name', () => {
    expect(normalizePlayer({ riotIdGameName: 'New', summonerName: 'Old' }).summonerName).toBe('New');
  });

  it('maps event names, including the first-turret alias', () => {
    expect(normalizeEvent({ EventName: 'DragonKill' }, 0).kind).toBe('DragonKill');
    expect(normalizeEvent({ EventName: 'FirstBrick' }, 0).kind).toBe('TurretKilled');
    expect(normalizeEvent({ EventName: 'HordeKill' }, 0).kind).toBe('HordeKill');
    expect(normalizeEvent({ EventName: 'SomethingNew' }, 0).kind).toBe('Unknown');
  });

  it('reads the stolen flag as a boolean', () => {
    expect(normalizeEvent({ EventName: 'BaronKill', Stolen: 'True' }, 0).stolen).toBe(true);
    expect(normalizeEvent({ EventName: 'BaronKill', Stolen: 'False' }, 0).stolen).toBe(false);
  });

  it('resolves the local player through a tagged Riot ID', () => {
    const snapshot = normalizeGameData({
      activePlayer: { riotIdGameName: 'Me#EUW' },
      allPlayers: [
        { riotIdGameName: 'Me', championName: 'Ahri', team: 'ORDER' },
        { riotIdGameName: 'Them', championName: 'Zed', team: 'CHAOS' },
      ],
      gameData: { gameTime: 300, gameMode: 'CLASSIC' },
    });
    expect(snapshot.self?.championName).toBe('Ahri');
    expect(snapshot.selfTeam).toBe('ORDER');
    expect(snapshot.gameTime).toBe(300);
  });

  it('survives a completely empty payload', () => {
    const snapshot = normalizeGameData({});
    expect(snapshot.self).toBeNull();
    expect(snapshot.players).toEqual([]);
    expect(snapshot.gameTime).toBe(0);
  });
});

describe('data dragon derivation', () => {
  const base = {
    id: 'Test', key: '999', name: 'Test', title: 't', partype: 'Mana',
    stats: { attackrange: 550, hp: 500, armor: 20, spellblock: 30 },
  };

  it('classifies attack range as melee or ranged', () => {
    expect(deriveFromDDragon({ ...base, tags: ['Mage'], info: { attack: 2, defense: 4, magic: 8, difficulty: 5 } }).range).toBe('ranged');
    expect(deriveFromDDragon({ ...base, stats: { ...base.stats, attackrange: 125 }, tags: ['Fighter'], info: { attack: 8, defense: 5, magic: 2, difficulty: 4 } }).range).toBe('melee');
  });

  it('infers a damage profile from Riot flavour ratings', () => {
    expect(deriveFromDDragon({ ...base, tags: ['Mage'], info: { attack: 2, defense: 4, magic: 9, difficulty: 5 } }).damage).toBe('magic');
    expect(deriveFromDDragon({ ...base, tags: ['Marksman'], info: { attack: 9, defense: 2, magic: 1, difficulty: 5 } }).damage).toBe('physical');
    expect(deriveFromDDragon({ ...base, tags: ['Fighter'], info: { attack: 5, defense: 5, magic: 5, difficulty: 5 } }).damage).toBe('mixed');
  });

  it('uses neutral, not zero, ratings for unknown champions', () => {
    // Zeroed ratings would make the comp analyser think the champion is useless.
    const derived = deriveFromDDragon({ ...base, tags: ['Mage'], info: { attack: 2, defense: 4, magic: 8, difficulty: 5 } });
    expect(derived.cc).toBeGreaterThan(0);
    expect(derived.waveclear).toBeGreaterThan(0);
  });

  it('always assigns at least one class', () => {
    const derived = deriveFromDDragon({ ...base, tags: [], info: { attack: 5, defense: 5, magic: 5, difficulty: 5 } });
    expect(derived.classes.length).toBeGreaterThan(0);
  });
});

describe('meta collection', () => {
  function match(id: string, patch = '26.14.1', overrides: Partial<MatchDetail['info']> = {}): MatchDetail {
    return {
      metadata: { matchId: id, participants: [] },
      info: {
        gameCreation: 0,
        gameDuration: 1800,
        gameMode: 'CLASSIC',
        gameVersion: patch,
        queueId: 420,
        participants: [
          participant('Ahri', 'MIDDLE', true),
          participant('Zed', 'MIDDLE', false),
        ],
        ...overrides,
      },
    };
  }

  function participant(championName: string, teamPosition: string, win: boolean) {
    return {
      puuid: `${championName}-puuid`, championName, championId: 1,
      teamId: win ? 100 : 200, win,
      kills: 5, deaths: 3, assists: 7,
      totalMinionsKilled: 200, neutralMinionsKilled: 10,
      visionScore: 20, goldEarned: 12000, teamPosition, champLevel: 16,
    };
  }

  function emptyState(patch = '26.14'): MetaState {
    return { patch, updatedAt: '', seenMatchIds: [], totalMatches: 0, tallies: {} };
  }

  it('tallies wins and games per champion', () => {
    const state = emptyState();
    expect(accumulateMatch(state, match('M1'))).toBe(true);
    expect(state.tallies['Ahri']).toEqual({ games: 1, wins: 1, byRole: { mid: { games: 1, wins: 1 } } });
    expect(state.tallies['Zed']?.wins).toBe(0);
  });

  it('refuses to double-count the same match', () => {
    const state = emptyState();
    accumulateMatch(state, match('M1'));
    expect(accumulateMatch(state, match('M1'))).toBe(false);
    expect(state.totalMatches).toBe(1);
  });

  it('skips non-ranked queues', () => {
    const state = emptyState();
    expect(accumulateMatch(state, match('M1', '26.14.1', { queueId: 450 }))).toBe(false);
  });

  it('skips remakes that would poison win rates', () => {
    const state = emptyState();
    expect(accumulateMatch(state, match('M1', '26.14.1', { gameDuration: 200 }))).toBe(false);
  });

  it('skips matches from a different patch', () => {
    const state = emptyState('26.14');
    expect(accumulateMatch(state, match('M1', '26.13.1'))).toBe(false);
  });

  it('computes win and pick rates against the match count', () => {
    const state = emptyState();
    accumulateMatch(state, match('M1'));
    accumulateMatch(state, match('M2'));
    const snapshot = toSnapshot(state);
    const ahri = snapshot.byChampion.find((c) => c.championId === 'Ahri' && !c.role)!;
    expect(ahri.games).toBe(2);
    expect(ahri.winRate).toBe(100);
    expect(ahri.pickRate).toBe(100);
    expect(snapshot.sampleSize).toBe(2);
    expect(snapshot.source).toBe('riot-api-sample');
  });

  it('reports an empty sample honestly rather than as data', () => {
    expect(toSnapshot(emptyState()).source).toBe('none');
  });
});

describe('patch strings', () => {
  it('shortens Riot game versions to major.minor', () => {
    expect(shortPatch('26.14.567.1234')).toBe('26.14');
    expect(shortPatch('26.14')).toBe('26.14');
  });
});

describe('match import', () => {
  const timeline: MatchTimeline = {
    metadata: { matchId: 'M1', participants: ['me', 'them'] },
    info: {
      participants: [
        { participantId: 1, puuid: 'me' },
        { participantId: 2, puuid: 'them' },
      ],
      frames: Array.from({ length: 21 }, (_, minute) => ({
        timestamp: minute * 60_000,
        participantFrames: {
          '1': { participantId: 1, minionsKilled: minute * 7, jungleMinionsKilled: 0, level: 1 + minute, totalGold: minute * 400, xp: minute * 300 },
          '2': { participantId: 2, minionsKilled: minute * 6, jungleMinionsKilled: 0, level: 1 + minute, totalGold: minute * 350, xp: minute * 280 },
        },
        events:
          minute === 5
            ? [{ type: 'CHAMPION_KILL', timestamp: 5 * 60_000, killerId: 2, victimId: 1 }]
            : [],
      })),
    },
  };

  const match: MatchDetail = {
    metadata: { matchId: 'M1', participants: ['me', 'them'] },
    info: {
      gameCreation: 1_700_000_000_000,
      gameDuration: 1200,
      gameEndTimestamp: 1_700_000_000_000 + 1_200_000,
      gameMode: 'CLASSIC',
      gameVersion: '26.14.1',
      queueId: 420,
      participants: [
        { puuid: 'me', championName: 'Ahri', championId: 103, teamId: 100, win: true, kills: 8, deaths: 2, assists: 6, totalMinionsKilled: 180, neutralMinionsKilled: 4, visionScore: 22, goldEarned: 13000, teamPosition: 'MIDDLE', champLevel: 16 },
        { puuid: 'them', championName: 'Zed', championId: 238, teamId: 200, win: false, kills: 3, deaths: 7, assists: 2, totalMinionsKilled: 150, neutralMinionsKilled: 0, visionScore: 12, goldEarned: 9000, teamPosition: 'MIDDLE', champLevel: 14 },
      ],
    },
  };

  it('reads CS at a given minute from the timeline', () => {
    expect(csAtMinute(timeline, 1, 10)).toBe(70);
    expect(csAtMinute(timeline, 2, 10)).toBe(60);
  });

  it('refuses to report a benchmark the game never reached', () => {
    expect(csAtMinute(timeline, 1, 30)).toBeNull();
  });

  it('counts deaths before a cutoff', () => {
    expect(deathsBefore(timeline, 1, 10)).toBe(1);
    expect(deathsBefore(timeline, 2, 10)).toBe(0);
  });

  it('builds a full record with the real result and lane opponent', () => {
    const record = toGameRecord(match, 'me', timeline)!;
    expect(record.champion).toBe('Ahri');
    expect(record.win).toBe(true);
    expect(record.role).toBe('mid');
    expect(record.cs).toBe(184);
    expect(record.csPerMin).toBe(9.2);
    expect(record.csAt10).toBe(70);
    expect(record.csDiffAt10).toBe(10);
    expect(record.deathsBefore10).toBe(1);
    expect(record.laneOpponent).toBe('Zed');
  });

  it('still produces a record without a timeline, with benchmarks null', () => {
    const record = toGameRecord(match, 'me', null)!;
    expect(record.csAt10).toBeNull();
    expect(record.csDiffAt10).toBeNull();
    expect(record.cs).toBe(184);
  });

  it('returns null when the player is not in the match', () => {
    expect(toGameRecord(match, 'someone-else', timeline)).toBeNull();
  });
});

describe('lockfile parsing', () => {
  it('reads port, password, and protocol', () => {
    expect(parseLockfile('LeagueClient:1234:52001:secretpw:https')).toEqual({
      port: 52001,
      password: 'secretpw',
      protocol: 'https',
    });
  });

  it('rejects a truncated lockfile', () => {
    expect(parseLockfile('LeagueClient:1234')).toBeNull();
  });
});

describe('champ select reading', () => {
  it('reports whose turn it is and which roles are assigned', () => {
    const draft = toDraftState({
      actions: [[{ actorCellId: 0, championId: 0, completed: false, isAllyAction: true, type: 'pick' }]],
      localPlayerCellId: 0,
      myTeam: [{ cellId: 0, championId: 0, championPickIntent: 0, assignedPosition: 'middle' }],
      theirTeam: [],
      bans: {},
    });
    expect(draft.isMyTurn).toBe(true);
    expect(draft.myRole).toBe('mid');
  });

  it('is not my turn when the pending action belongs to someone else', () => {
    const draft = toDraftState({
      actions: [[{ actorCellId: 3, championId: 0, completed: false, isAllyAction: true, type: 'pick' }]],
      localPlayerCellId: 0,
      myTeam: [{ cellId: 0, championId: 0, championPickIntent: 0, assignedPosition: 'middle' }],
      theirTeam: [],
      bans: {},
    });
    expect(draft.isMyTurn).toBe(false);
  });

  it('omits champions it cannot resolve rather than inventing them', () => {
    // Numeric ids only resolve once Data Dragon has loaded.
    const draft = toDraftState({
      actions: [],
      localPlayerCellId: 0,
      myTeam: [{ cellId: 0, championId: 99999, championPickIntent: 0, assignedPosition: 'middle' }],
      theirTeam: [],
      bans: {},
    });
    expect(draft.allies).toEqual([]);
  });
});
