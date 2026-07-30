import type { ChampionData, ChampionMetaStats, MetaSnapshot, Role } from '../types.js';
import { CHAMPIONS as CURATED } from './champions.js';

/**
 * The champion registry: one merged, evolving view of champion data.
 *
 * Three layers, in increasing order of authority for the fields each owns:
 *
 *   1. Curated table  — judgement fields (cc, engage, peel, waveclear, scaling)
 *                       that Riot does not publish and cannot be derived.
 *   2. Data Dragon    — factual fields (existence, exact id, display name,
 *                       melee/ranged, class tags). Patch-synced, so new
 *                       champions appear here the day they ship.
 *   3. Meta sample    — which roles a champion is *actually* played in, plus
 *                       win/pick rates, from real sampled matches.
 *
 * Layer 1 ships in the binary so the app works offline on first run. Layers 2
 * and 3 hydrate asynchronously and overwrite only the fields they own, which is
 * what keeps the dataset current without a release.
 */

/**
 * Share of a role's total games a champion must account for to count as played
 * there. With ~170 champions, uniform distribution would be ~0.6%, so this is
 * roughly "at least as common as an average pick for the role".
 */
const ROLE_PRESENCE_THRESHOLD = 0.5;

/**
 * Absolute floor alongside the share test. Without it, a thin sample makes the
 * percentage meaningless — at 60 games in a role, a single off-role game clears
 * any share threshold and would redefine the champion's roles.
 */
const MIN_ROLE_GAMES = 5;

/** Below this many games a meta win rate is noise and is withheld from the UI. */
export const MIN_META_GAMES = 30;

export interface RegistryDiscrepancy {
  championId: string;
  field: string;
  curated: string;
  official: string;
}

export interface DDragonLayer {
  version: string;
  champions: ChampionData[];
  raw: Record<string, { attackrange: number; tags: string[]; name: string }>;
  numericKeys?: Record<string, string>;
}

export class ChampionRegistry {
  private champions = new Map<string, ChampionData>();
  private meta = new Map<string, ChampionMetaStats>();
  private metaSnapshot: MetaSnapshot | null = null;
  private ddragonVersion: string | null = null;
  private discrepancies: RegistryDiscrepancy[] = [];
  /** Riot's numeric champion key -> our champion id, from Data Dragon. */
  private numericKeys = new Map<number, string>();

  constructor(seed: ChampionData[] = CURATED) {
    for (const c of seed) this.champions.set(c.id, { ...c });
  }

  /**
   * Merges the official patch data in.
   *
   * Factual fields win; judgement fields are preserved from the curated entry.
   * Champions Riot has that we do not are added with derived defaults so the
   * draft tool never silently ignores a new release.
   */
  applyDDragon(layer: DDragonLayer): void {
    this.ddragonVersion = layer.version;
    this.discrepancies = [];

    for (const [key, id] of Object.entries(layer.numericKeys ?? {})) {
      const numeric = Number(key);
      if (Number.isFinite(numeric)) this.numericKeys.set(numeric, id);
    }

    for (const official of layer.champions) {
      const curated = this.champions.get(official.id);

      if (!curated) {
        this.champions.set(official.id, { ...official });
        continue;
      }

      // Record where our hand data disagrees with Riot, so it can be fixed.
      if (curated.range !== official.range) {
        this.discrepancies.push({
          championId: official.id,
          field: 'range',
          curated: curated.range,
          official: official.range,
        });
      }
      if (curated.name !== official.name) {
        this.discrepancies.push({
          championId: official.id,
          field: 'name',
          curated: curated.name,
          official: official.name,
        });
      }

      this.champions.set(official.id, {
        ...curated,
        // Riot owns these.
        name: official.name,
        range: official.range,
      });
    }
  }

  /**
   * Attaches sampled match data and derives real role assignments.
   *
   * Roles from the meta replace the curated guesses entirely: what champions are
   * actually played where is exactly the thing that shifts patch to patch.
   */
  applyMeta(snapshot: MetaSnapshot): void {
    this.metaSnapshot = snapshot;
    this.meta.clear();

    // Total games per role, used to turn raw counts into a presence share.
    const roleTotals = new Map<Role, number>();
    for (const stat of snapshot.byChampion) {
      if (!stat.role) continue;
      roleTotals.set(stat.role, (roleTotals.get(stat.role) ?? 0) + stat.games);
    }

    const derivedRoles = new Map<string, Role[]>();

    for (const stat of snapshot.byChampion) {
      this.meta.set(this.metaKey(stat.championId, stat.role), stat);

      if (!stat.role) continue;
      const total = roleTotals.get(stat.role) ?? 0;
      if (total === 0) continue;
      // What share of everything played in this role is this champion.
      const share = (stat.games / total) * 100;
      if (share >= ROLE_PRESENCE_THRESHOLD && stat.games >= MIN_ROLE_GAMES) {
        const list = derivedRoles.get(stat.championId) ?? [];
        list.push(stat.role);
        derivedRoles.set(stat.championId, list);
      }
    }

    for (const [championId, roles] of derivedRoles) {
      const champ = this.champions.get(championId);
      // Only trust the derived roles when the sample is large enough to mean
      // something; otherwise keep the curated ones.
      if (champ && snapshot.sampleSize >= MIN_META_GAMES && roles.length > 0) {
        this.champions.set(championId, { ...champ, roles });
      }
    }
  }

  private metaKey(championId: string, role?: Role): string {
    return role ? `${championId}:${role}` : championId;
  }

  all(): ChampionData[] {
    return [...this.champions.values()];
  }

  get(idOrName: string): ChampionData | undefined {
    const key = idOrName.trim();
    const direct = this.champions.get(key);
    if (direct) return direct;
    const lower = key.toLowerCase();
    for (const c of this.champions.values()) {
      if (c.id.toLowerCase() === lower || c.name.toLowerCase() === lower) return c;
    }
    const stripped = lower.replace(/[^a-z]/g, '');
    for (const c of this.champions.values()) {
      if (c.id.toLowerCase() === stripped) return c;
    }
    return undefined;
  }

  forRole(role: Role): ChampionData[] {
    return this.all().filter((c) => c.roles.includes(role));
  }

  /**
   * Resolves champ select's numeric champion id. Requires Data Dragon to have
   * loaded at least once; returns undefined before then.
   */
  getByNumericKey(key: number): ChampionData | undefined {
    const id = this.numericKeys.get(key);
    return id ? this.champions.get(id) : undefined;
  }

  /** True once champ select ids can be resolved. */
  hasNumericKeys(): boolean {
    return this.numericKeys.size > 0;
  }

  /**
   * Meta stats for a champion, preferring the role-specific row.
   * Returns undefined when the sample is too thin to report honestly.
   */
  metaFor(championId: string, role?: Role): ChampionMetaStats | undefined {
    const specific = role ? this.meta.get(this.metaKey(championId, role)) : undefined;
    const overall = this.meta.get(this.metaKey(championId));
    const chosen = specific ?? overall;
    if (!chosen || chosen.games < MIN_META_GAMES) return undefined;
    return chosen;
  }

  getMetaSnapshot(): MetaSnapshot | null {
    return this.metaSnapshot;
  }

  getDDragonVersion(): string | null {
    return this.ddragonVersion;
  }

  /** Where the curated table disagrees with Riot — surfaced in settings. */
  getDiscrepancies(): RegistryDiscrepancy[] {
    return [...this.discrepancies];
  }
}

/** Process-wide registry. Hydrated by the main process on startup. */
export const registry = new ChampionRegistry();
