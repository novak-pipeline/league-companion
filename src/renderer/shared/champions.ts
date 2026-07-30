import { findChampion } from '../../core/draft/champions.js';

/**
 * Display-layer champion helpers.
 *
 * The live game reports display names ("Miss Fortune", "Wukong") while Data
 * Dragon keys its art by id ("MissFortune", "MonkeyKing"). The curated table
 * ships in the binary, so this resolution works offline and on first run.
 */

/** Best-effort Data Dragon id for whatever the caller has: an id or a name. */
export function championIdFor(idOrName: string): string {
  const match = findChampion(idOrName);
  if (match) return match.id;
  // Unknown champion (brand new, or a mode-specific unit): strip the characters
  // Data Dragon ids never contain and hope for the best. The portrait falls back
  // to an initial tile if this guess misses, which is the intended behaviour.
  return idOrName.replace(/[^A-Za-z0-9]/g, '');
}

/** Human-readable name for a champion id, falling back to the id itself. */
export function championNameFor(idOrName: string): string {
  return findChampion(idOrName)?.name ?? idOrName;
}
