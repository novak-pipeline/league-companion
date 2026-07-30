import type {
  ChampionData,
  DraftAdvice,
  DraftState,
  DraftSuggestion,
  GameRecord,
  Role,
} from '../types.js';
import { analyzeComp, compareComps } from './compScore.js';
import { ChampionRegistry, registry as defaultRegistry } from './registry.js';

/**
 * Draft suggestions.
 *
 * A candidate is scored by how much it improves the *team's* composition score
 * — a marginal-gain model. That keeps the recommendation honest: it answers
 * "what does this comp still need?" rather than pretending to know matchup
 * win rates it has no data for.
 *
 * Personal performance is reported alongside the fit score, never blended into
 * it, so a champion you happen to be on a hot streak with cannot masquerade as
 * a good team-fit pick.
 */

export interface AdviceOptions {
  /** Restrict suggestions to this pool; empty means the whole roster. */
  championPool: string[];
  /** Your own match history, used to annotate suggestions. */
  history: GameRecord[];
  /** How many suggestions to return. */
  limit: number;
  /** Require at least this many games before showing a personal win rate. */
  minGamesForWinRate: number;
  /** Champion data source. Defaults to the process-wide hydrated registry. */
  registry: ChampionRegistry;
  /**
   * How much sampled meta performance may influence the ordering, 0-1.
   * Kept low and separate from `fitScore`: meta win rates describe how the
   * champion does for everyone, not how it fits *this* comp.
   */
  metaWeight: number;
}

export const DEFAULT_ADVICE_OPTIONS: AdviceOptions = {
  championPool: [],
  history: [],
  limit: 6,
  minGamesForWinRate: 3,
  registry: defaultRegistry,
  metaWeight: 0.25,
};

function resolve(
  ids: Array<{ championId: string }>,
  reg: ChampionRegistry,
): ChampionData[] {
  return ids
    .map((p) => reg.get(p.championId))
    .filter((c): c is ChampionData => c !== undefined);
}

/** Per-champion record from the local history. */
export function personalRecord(
  history: GameRecord[],
  championId: string,
  reg: ChampionRegistry = defaultRegistry,
): { games: number; wins: number; winRate: number } | undefined {
  const champ = reg.get(championId);
  if (!champ) return undefined;
  const played = history.filter((g) => {
    const c = reg.get(g.champion);
    return c?.id === champ.id;
  });
  if (played.length === 0) return undefined;
  // Games where the result is unknown still count as games played, but only
  // decided games feed the win rate.
  const decided = played.filter((g) => g.win !== null);
  const wins = decided.filter((g) => g.win === true).length;
  return {
    games: played.length,
    wins,
    winRate: decided.length === 0 ? 0 : Math.round((wins / decided.length) * 100),
  };
}

/**
 * Why this champion helps, expressed as short phrases. Derived by diffing the
 * comp's gaps against what the candidate brings.
 */
function reasonsFor(candidate: ChampionData, allies: ChampionData[]): string[] {
  const before = analyzeComp(allies);
  const reasons: string[] = [];

  if (allies.length > 0) {
    const needsMagic = before.damageMix.physical >= 70;
    const needsPhysical = before.damageMix.magic >= 70;
    if (needsMagic && (candidate.damage === 'magic' || candidate.damage === 'mixed')) {
      reasons.push('balances a physical-heavy comp');
    }
    if (needsPhysical && (candidate.damage === 'physical' || candidate.damage === 'mixed')) {
      reasons.push('balances a magic-heavy comp');
    }
  }

  if (before.frontline <= 2 && candidate.classes.includes('tank')) {
    reasons.push('adds the frontline you are missing');
  }
  if (before.engage <= 1 && candidate.engage >= 2) reasons.push('gives you engage');
  if (before.peel <= 1 && candidate.peel >= 2) reasons.push('adds peel for your carry');
  if (before.cc <= 3 && candidate.cc >= 2) reasons.push('adds crowd control');
  if (before.waveclear <= 3 && candidate.waveclear >= 2) reasons.push('helps you clear waves');
  if (candidate.scaling === 'late' && before.scaling.late === 0) reasons.push('gives you a late-game win condition');

  return reasons;
}

/**
 * Scores every eligible champion by marginal contribution to the ally comp.
 * The raw delta is small (a single pick moves the comp score by a handful of
 * points), so it is rescaled into a readable 0-100 fit.
 */
export function suggestPicks(
  draft: DraftState,
  role: Role | undefined,
  options: Partial<AdviceOptions> = {},
): DraftSuggestion[] {
  const opts: AdviceOptions = { ...DEFAULT_ADVICE_OPTIONS, ...options };
  const reg = opts.registry;
  const allies = resolve(draft.allies, reg);
  const taken = new Set(
    [...draft.allies, ...draft.enemies].map((p) => reg.get(p.championId)?.id).filter(Boolean),
  );
  const banned = new Set(draft.bans.map((b) => reg.get(b)?.id).filter(Boolean));

  let pool: ChampionData[] = role ? reg.forRole(role) : reg.all();
  if (opts.championPool.length > 0) {
    const allowed = new Set(
      opts.championPool.map((c) => reg.get(c)?.id).filter((id): id is string => Boolean(id)),
    );
    pool = pool.filter((c) => allowed.has(c.id));
  }
  pool = pool.filter((c) => !taken.has(c.id) && !banned.has(c.id));

  const base = analyzeComp(allies).score;
  const scored = pool.map((candidate) => {
    const delta = analyzeComp([...allies, candidate]).score - base;
    return { candidate, delta };
  });

  const deltas = scored.map((s) => s.delta);
  const min = Math.min(...deltas, 0);
  const max = Math.max(...deltas, 1);
  const span = max - min || 1;

  return scored
    .map(({ candidate, delta }): DraftSuggestion => {
      const record = personalRecord(opts.history, candidate.id, reg);
      const meta = reg.metaFor(candidate.id, role);
      return {
        championId: candidate.id,
        name: candidate.name,
        fitScore: Math.round(((delta - min) / span) * 100),
        reasons: reasonsFor(candidate, allies),
        personal: record && record.games >= opts.minGamesForWinRate ? record : undefined,
        meta,
      };
    })
    .sort((a, b) => {
      // Rank on comp fit, nudged by how the champion is actually performing on
      // this patch. A 55% win rate contributes at most `metaWeight` * 100 * 0.1
      // points, so meta breaks ties without overriding a genuine comp need.
      const metaBonus = (s: DraftSuggestion): number =>
        s.meta ? (s.meta.winRate - 50) * opts.metaWeight : 0;
      const aScore = a.fitScore + metaBonus(a);
      const bScore = b.fitScore + metaBonus(b);
      if (bScore !== aScore) return bScore - aScore;
      // Break remaining ties toward champions you actually play.
      return (b.personal?.games ?? 0) - (a.personal?.games ?? 0);
    })
    .slice(0, opts.limit);
}

/** Full draft read: both comps, the comparisons, and what to pick. */
export function analyzeDraft(
  draft: DraftState,
  options: Partial<AdviceOptions> = {},
): DraftAdvice {
  const reg = options.registry ?? DEFAULT_ADVICE_OPTIONS.registry;
  const ally = analyzeComp(resolve(draft.allies, reg));
  const enemy = analyzeComp(resolve(draft.enemies, reg));
  return {
    ally,
    enemy,
    edges: compareComps(ally, enemy),
    suggestions: draft.isMyTurn ? suggestPicks(draft, draft.myRole, options) : [],
  };
}
