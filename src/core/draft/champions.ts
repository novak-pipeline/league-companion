import type { ChampClass, ChampionData, DamageProfile, Role, ScalingCurve } from '../types.js';
import { CHAMPION_ROWS } from './championData.js';

/**
 * Parses the compact champion table into structured data.
 *
 * The table is stored as pipe-delimited strings rather than object literals to
 * keep ~170 champions reviewable in a diff. Parsing happens once at module load.
 */

const DAMAGE: Record<string, DamageProfile> = { P: 'physical', M: 'magic', X: 'mixed' };
const SCALING: Record<string, ScalingCurve> = { e: 'early', m: 'mid', l: 'late' };
const VALID_CLASSES: ChampClass[] = [
  'tank',
  'fighter',
  'assassin',
  'mage',
  'marksman',
  'enchanter',
  'catcher',
];
const VALID_ROLES: Role[] = ['top', 'jungle', 'mid', 'adc', 'support'];

function parseRow(row: string, lineNumber: number): ChampionData {
  const parts = row.split('|');
  if (parts.length !== 11) {
    throw new Error(`champion row ${lineNumber} has ${parts.length} fields, expected 11: ${row}`);
  }
  const [id, name, classes, damage, range, cc, engage, peel, waveclear, scaling, roles] = parts as [
    string, string, string, string, string, string, string, string, string, string, string,
  ];

  const parsedClasses = classes.split(',').map((c) => c.trim()) as ChampClass[];
  for (const c of parsedClasses) {
    if (!VALID_CLASSES.includes(c)) throw new Error(`unknown class "${c}" on ${id}`);
  }

  const parsedRoles = roles.split(',').map((r) => r.trim()) as Role[];
  for (const r of parsedRoles) {
    if (!VALID_ROLES.includes(r)) throw new Error(`unknown role "${r}" on ${id}`);
  }

  const damageProfile = DAMAGE[damage];
  if (!damageProfile) throw new Error(`unknown damage code "${damage}" on ${id}`);
  const scalingCurve = SCALING[scaling];
  if (!scalingCurve) throw new Error(`unknown scaling code "${scaling}" on ${id}`);
  if (range !== 'm' && range !== 'r') throw new Error(`unknown range code "${range}" on ${id}`);

  const num = (raw: string, field: string): number => {
    const v = Number(raw);
    if (!Number.isInteger(v) || v < 0 || v > 3) {
      throw new Error(`${field} on ${id} must be an integer 0-3, got "${raw}"`);
    }
    return v;
  };

  return {
    id,
    name,
    classes: parsedClasses,
    damage: damageProfile,
    range: range === 'm' ? 'melee' : 'ranged',
    cc: num(cc, 'cc'),
    engage: num(engage, 'engage'),
    peel: num(peel, 'peel'),
    waveclear: num(waveclear, 'waveclear'),
    scaling: scalingCurve,
    roles: parsedRoles,
  };
}

export const CHAMPIONS: ChampionData[] = CHAMPION_ROWS.map(parseRow);

const BY_ID = new Map(CHAMPIONS.map((c) => [c.id.toLowerCase(), c]));
const BY_NAME = new Map(CHAMPIONS.map((c) => [c.name.toLowerCase(), c]));

/** Looks a champion up by Data Dragon id or display name, case-insensitively. */
export function findChampion(idOrName: string): ChampionData | undefined {
  const key = idOrName.trim().toLowerCase();
  return BY_ID.get(key) ?? BY_NAME.get(key) ?? BY_ID.get(key.replace(/[^a-z]/g, ''));
}

export function championsForRole(role: Role): ChampionData[] {
  return CHAMPIONS.filter((c) => c.roles.includes(role));
}

/** Riot's CDN portrait URL. Version is pinned by the caller's settings. */
export function portraitUrl(championId: string, ddragonVersion: string): string {
  return `https://ddragon.leagueoflegends.com/cdn/${ddragonVersion}/img/champion/${championId}.png`;
}
