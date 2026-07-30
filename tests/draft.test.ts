import { describe, expect, it } from 'vitest';
import { CHAMPIONS, findChampion } from '../src/core/draft/champions.js';
import { analyzeComp, compareComps, damageMix } from '../src/core/draft/compScore.js';
import { analyzeDraft, personalRecord, suggestPicks } from '../src/core/draft/advice.js';
import { ChampionRegistry } from '../src/core/draft/registry.js';
import type { DraftState, GameRecord } from '../src/core/types.js';

const champs = (...names: string[]) =>
  names.map((n) => {
    const c = findChampion(n);
    if (!c) throw new Error(`test fixture missing champion: ${n}`);
    return c;
  });

describe('champion table', () => {
  it('parses every row', () => {
    expect(CHAMPIONS.length).toBeGreaterThan(150);
  });

  it('has unique ids', () => {
    const ids = new Set(CHAMPIONS.map((c) => c.id));
    expect(ids.size).toBe(CHAMPIONS.length);
  });

  it('keeps every rating inside 0-3', () => {
    for (const c of CHAMPIONS) {
      for (const field of ['cc', 'engage', 'peel', 'waveclear'] as const) {
        expect(c[field]).toBeGreaterThanOrEqual(0);
        expect(c[field]).toBeLessThanOrEqual(3);
      }
    }
  });

  it('gives every champion at least one role', () => {
    for (const c of CHAMPIONS) expect(c.roles.length).toBeGreaterThan(0);
  });

  it('looks champions up by id, display name, and punctuation-free name', () => {
    expect(findChampion('Ahri')?.id).toBe('Ahri');
    expect(findChampion('wukong')?.id).toBe('MonkeyKing');
    expect(findChampion("K'Sante")?.id).toBe('KSante');
    expect(findChampion('kaisa')?.id).toBe('Kaisa');
  });
});

describe('damage mix', () => {
  it('splits an all-physical comp to 100%', () => {
    expect(damageMix(champs('Jinx', 'Zed'))).toEqual({ physical: 100, magic: 0 });
  });

  it('counts a mixed champion toward both sides', () => {
    const mix = damageMix(champs('Jinx', 'Ahri'));
    expect(mix.physical).toBe(50);
    expect(mix.magic).toBe(50);
  });

  it('returns zeroes for an empty comp', () => {
    expect(damageMix([])).toEqual({ physical: 0, magic: 0 });
  });
});

describe('comp analysis', () => {
  it('flags a comp with no frontline', () => {
    const analysis = analyzeComp(champs('Jinx', 'Ahri', 'Zed'));
    expect(analysis.flags.some((f) => f.message.includes('frontline'))).toBe(true);
  });

  it('flags one-dimensional damage', () => {
    const analysis = analyzeComp(champs('Jinx', 'Zed', 'Yasuo'));
    expect(analysis.flags.some((f) => f.message.includes('physical'))).toBe(true);
  });

  it('scores a balanced comp above a broken one', () => {
    const balanced = analyzeComp(champs('Ornn', 'Ahri', 'Jinx', 'Thresh', 'LeeSin'));
    const broken = analyzeComp(champs('Zed', 'Yasuo', 'Katarina', 'Talon', 'MasterYi'));
    expect(balanced.score).toBeGreaterThan(broken.score);
  });

  it('keeps the score inside 0-100', () => {
    expect(analyzeComp([]).score).toBeGreaterThanOrEqual(0);
    expect(analyzeComp(champs('Ornn', 'Ahri', 'Jinx', 'Thresh', 'LeeSin')).score).toBeLessThanOrEqual(100);
  });

  it('stays quiet about a comp too small to judge', () => {
    expect(analyzeComp(champs('Ahri')).flags).toHaveLength(0);
  });
});

describe('comp comparison', () => {
  it('calls out a scaling mismatch', () => {
    const scaling = analyzeComp(champs('Jinx', 'Kayle', 'Veigar', 'Nasus', 'Vayne'));
    const early = analyzeComp(champs('Leona', 'LeeSin', 'Renekton', 'Draven', 'Pantheon'));
    const edges = compareComps(scaling, early);
    expect(edges.some((e) => e.toLowerCase().includes('scale'))).toBe(true);
  });

  it('produces no edges for two identical comps', () => {
    const comp = analyzeComp(champs('Ornn', 'Ahri', 'Jinx', 'Thresh', 'LeeSin'));
    expect(compareComps(comp, comp)).toHaveLength(0);
  });
});

describe('suggestions', () => {
  const draft: DraftState = {
    allies: [{ championId: 'Jinx' }, { championId: 'Zed' }],
    enemies: [{ championId: 'Leona' }],
    bans: ['Yasuo'],
    myRole: 'top',
    isMyTurn: true,
  };

  it('returns picks for the requested role only', () => {
    const picks = suggestPicks(draft, 'top');
    expect(picks.length).toBeGreaterThan(0);
    for (const p of picks) {
      expect(findChampion(p.championId)!.roles).toContain('top');
    }
  });

  it('never suggests a taken or banned champion', () => {
    const ids = suggestPicks(draft, 'top', { limit: 50 }).map((p) => p.championId);
    expect(ids).not.toContain('Jinx');
    expect(ids).not.toContain('Zed');
    expect(ids).not.toContain('Leona');
    expect(ids).not.toContain('Yasuo');
  });

  it('respects a restricted champion pool', () => {
    const picks = suggestPicks(draft, 'top', { championPool: ['Ornn', 'Malphite'] });
    expect(picks.map((p) => p.championId).sort()).toEqual(['Malphite', 'Ornn']);
  });

  it('explains why it is recommending a pick', () => {
    const picks = suggestPicks(draft, 'top', { limit: 3 });
    expect(picks.some((p) => p.reasons.length > 0)).toBe(true);
  });

  it('honours the limit', () => {
    expect(suggestPicks(draft, 'top', { limit: 4 })).toHaveLength(4);
  });

  it('stays silent when it is not my turn', () => {
    const advice = analyzeDraft({ ...draft, isMyTurn: false });
    expect(advice.suggestions).toHaveLength(0);
  });
});

describe('personal record', () => {
  const history: GameRecord[] = [
    makeGame('Ahri', true),
    makeGame('Ahri', false),
    makeGame('Ahri', true),
    makeGame('Zed', true),
  ];

  function makeGame(champion: string, win: boolean): GameRecord {
    return {
      id: `${champion}-${Math.random()}`,
      startedAt: '2026-01-01T00:00:00Z',
      endedAt: '2026-01-01T00:30:00Z',
      gameMode: 'CLASSIC',
      champion,
      win,
      durationSeconds: 1800,
      kills: 5, deaths: 3, assists: 7,
      cs: 200, csPerMin: 6.7,
      csAt10: 70, csAt15: 110, csDiffAt10: 5,
      deathsBefore10: 1,
      laneOpponent: null,
      samples: [],
    };
  }

  it('computes games and win rate', () => {
    const record = personalRecord(history, 'Ahri');
    expect(record).toEqual({ games: 3, wins: 2, winRate: 67 });
  });

  it('returns undefined for an unplayed champion', () => {
    expect(personalRecord(history, 'Garen')).toBeUndefined();
  });

  it('excludes unresolved results from the win rate', () => {
    const withUnknown = [...history, { ...makeGame('Ahri', true), win: null }];
    expect(personalRecord(withUnknown, 'Ahri')).toEqual({ games: 4, wins: 2, winRate: 67 });
  });
});

describe('registry layering', () => {
  it('adds champions Riot has that the curated table does not', () => {
    const reg = new ChampionRegistry([]);
    reg.applyDDragon({
      version: '26.14.1',
      champions: [
        {
          id: 'NewChamp', name: 'New Champ', classes: ['mage'], damage: 'magic',
          range: 'ranged', cc: 1, engage: 1, peel: 1, waveclear: 2, scaling: 'mid', roles: [],
        },
      ],
      raw: {},
      numericKeys: { '999': 'NewChamp' },
    });
    expect(reg.get('NewChamp')?.name).toBe('New Champ');
    expect(reg.getByNumericKey(999)?.id).toBe('NewChamp');
  });

  it('keeps curated judgement fields but takes Riot factual fields', () => {
    const reg = new ChampionRegistry([
      {
        id: 'Ahri', name: 'Old Name', classes: ['mage'], damage: 'magic',
        range: 'melee', cc: 3, engage: 2, peel: 1, waveclear: 2, scaling: 'late', roles: ['mid'],
      },
    ]);
    reg.applyDDragon({
      version: '26.14.1',
      champions: [
        {
          id: 'Ahri', name: 'Ahri', classes: ['mage'], damage: 'magic',
          range: 'ranged', cc: 1, engage: 1, peel: 1, waveclear: 2, scaling: 'mid', roles: [],
        },
      ],
      raw: {},
    });
    const ahri = reg.get('Ahri')!;
    expect(ahri.name).toBe('Ahri');
    expect(ahri.range).toBe('ranged');
    // Judgement fields survive.
    expect(ahri.cc).toBe(3);
    expect(ahri.scaling).toBe('late');
    expect(reg.getDiscrepancies().map((d) => d.field).sort()).toEqual(['name', 'range']);
  });

  it('withholds meta win rates built on a thin sample', () => {
    const reg = new ChampionRegistry();
    reg.applyMeta({
      patch: '26.14',
      updatedAt: '2026-07-30T00:00:00Z',
      sampleSize: 5,
      source: 'riot-api-sample',
      byChampion: [
        { championId: 'Ahri', games: 4, wins: 3, winRate: 75, pickRate: 80, patch: '26.14' },
      ],
    });
    expect(reg.metaFor('Ahri')).toBeUndefined();
  });

  it('ignores an off-role blip when deriving roles', () => {
    const reg = new ChampionRegistry();
    const before = reg.get('Ahri')!.roles;
    reg.applyMeta({
      patch: '26.14',
      updatedAt: '2026-07-30T00:00:00Z',
      sampleSize: 100,
      source: 'riot-api-sample',
      byChampion: [
        // A single support game clears any percentage threshold on a thin
        // sample, so the absolute floor is what stops it counting.
        { championId: 'Ahri', role: 'support', games: 1, wins: 1, winRate: 100, pickRate: 1, patch: '26.14' },
      ],
    });
    expect(reg.get('Ahri')!.roles).toEqual(before);
  });

  it('adopts a role once it is genuinely common', () => {
    const reg = new ChampionRegistry();
    reg.applyMeta({
      patch: '26.14',
      updatedAt: '2026-07-30T00:00:00Z',
      sampleSize: 500,
      source: 'riot-api-sample',
      byChampion: [
        { championId: 'Ahri', role: 'mid', games: 60, wins: 31, winRate: 51.7, pickRate: 12, patch: '26.14' },
      ],
    });
    expect(reg.get('Ahri')!.roles).toEqual(['mid']);
  });

  it('reports meta stats once the sample is large enough', () => {
    const reg = new ChampionRegistry();
    reg.applyMeta({
      patch: '26.14',
      updatedAt: '2026-07-30T00:00:00Z',
      sampleSize: 500,
      source: 'riot-api-sample',
      byChampion: [
        { championId: 'Ahri', games: 120, wins: 63, winRate: 52.5, pickRate: 24, patch: '26.14' },
      ],
    });
    expect(reg.metaFor('Ahri')?.winRate).toBe(52.5);
  });
});
