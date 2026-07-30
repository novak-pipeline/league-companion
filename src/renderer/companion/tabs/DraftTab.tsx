import type { CompanionState } from '../../../shared/ipc.js';
import type { CompAnalysis, DraftPick, DraftSuggestion } from '../../../core/types.js';

import { ChampionPortrait } from '../../shared/ChampionPortrait';
import { RoleBadge } from '../../shared/RoleBadge';
import { championIdFor, championNameFor } from '../../shared/champions';
import { clampPercent, formatCount, formatPercent, round, winRateTone } from '../../shared/format';

interface DraftTabProps {
  state: CompanionState;
}

function DamageMix({ comp }: { comp: CompAnalysis }): JSX.Element {
  const physical = clampPercent(comp.damageMix.physical);
  const magic = clampPercent(comp.damageMix.magic);
  const total = physical + magic;
  // Normalize so the two segments always fill the bar, even if the source
  // percentages do not sum to exactly 100.
  const physShare = total > 0 ? (physical / total) * 100 : 50;
  const magicShare = total > 0 ? 100 - physShare : 50;

  return (
    <div className="stack" style={{ gap: 6 }}>
      <div
        className="dmg-bar"
        role="img"
        aria-label={`Damage mix: ${round(physical)}% physical, ${round(magic)}% magic`}
      >
        <div className="dmg-seg dmg-physical" style={{ width: `${physShare}%` }}>
          {physShare >= 14 ? `${round(physical)}% AD` : null}
        </div>
        <div className="dmg-seg dmg-magic" style={{ width: `${magicShare}%` }}>
          {magicShare >= 14 ? `${round(magic)}% AP` : null}
        </div>
      </div>
      <div className="dmg-legend">
        <span>
          <span className="legend-swatch" style={{ background: 'var(--warn)' }} />
          Physical {round(physical)}%
        </span>
        <span>
          <span className="legend-swatch" style={{ background: 'var(--accent)' }} />
          Magic {round(magic)}%
        </span>
      </div>
    </div>
  );
}

const STAGES = ['early', 'mid', 'late'] as const;

/**
 * Power curve. `comp.scaling` counts champions per stage, not percentages, so
 * the bars are drawn as a share of the champions actually picked — otherwise a
 * two-pick comp would look like an empty one.
 */
function ScalingRow({ comp }: { comp: CompAnalysis }): JSX.Element {
  const counts = STAGES.map((stage) => Math.max(0, comp.scaling[stage]));
  const total = counts.reduce((sum, value) => sum + value, 0);

  return (
    <div className="scaling-row">
      <span className="scaling-caption">Power curve</span>
      <div className="scaling-bars">
        {STAGES.map((stage, index) => {
          const count = counts[index] ?? 0;
          const share = total > 0 ? (count / total) * 100 : 0;
          return (
            <div className="scaling" key={stage}>
              <span className="scaling-label">{stage}</span>
              <div className="mini-bar" role="img" aria-label={`${count} ${stage}-game champions`}>
                <div className={`mini-bar-fill mini-bar-fill--${stage}`} style={{ width: `${share}%` }} />
              </div>
              <span className="scaling-value">{count}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * The picked champions on one side. Five fixed slots so the two panels stay the
 * same height through the whole draft and nothing jumps as picks land.
 */
function PickList({
  picks,
  version,
  side,
}: {
  picks: DraftPick[];
  version: string | null;
  side: 'ally' | 'enemy';
}): JSX.Element {
  const slots = Array.from({ length: Math.max(5, picks.length) }, (_, index) => picks[index]);

  return (
    <ul className={`pick-list pick-list--${side}`}>
      {slots.map((pick, index) => {
        if (!pick) {
          return (
            <li className="pick pick--empty" key={`empty-${index}`}>
              <span className="pick-slot" aria-hidden="true" />
              <span className="pick-name">—</span>
            </li>
          );
        }

        const id = championIdFor(pick.championId);
        const name = championNameFor(pick.championId);

        return (
          <li className="pick" key={`${pick.championId}-${index}`}>
            <ChampionPortrait championId={id} name={name} version={version} size={32} />
            <span className="pick-name">{name}</span>
            {pick.role ? <RoleBadge role={pick.role} muted /> : null}
          </li>
        );
      })}
    </ul>
  );
}

function CompPanel({
  title,
  subtitle,
  comp,
  picks,
  version,
  side,
}: {
  title: string;
  subtitle: string;
  comp: CompAnalysis;
  picks: DraftPick[];
  version: string | null;
  side: 'ally' | 'enemy';
}): JSX.Element {
  const stats: Array<[string, number]> = [
    ['Frontline', comp.frontline],
    ['Engage', comp.engage],
    ['Peel', comp.peel],
    ['CC', comp.cc],
    ['Waveclear', comp.waveclear],
  ];

  return (
    <section className={`panel stack comp-panel comp-panel--${side}`}>
      <div className="panel-head" style={{ marginBottom: 0 }}>
        <div className="comp-heading">
          <h2 className="panel-title">{title}</h2>
          <span className="comp-heading-sub">{subtitle}</span>
        </div>
        <div className="comp-score">
          <span className="comp-score-value">{Math.round(comp.score)}</span>
          <span className="comp-score-max">/ 100</span>
        </div>
      </div>

      <PickList picks={picks} version={version} side={side} />

      <DamageMix comp={comp} />

      <div className="stat-row">
        {stats.map(([label, value]) => (
          <div className="stat" key={label}>
            <span className="stat-label">{label}</span>
            <span className="stat-value">{round(value)}</span>
          </div>
        ))}
      </div>

      <ScalingRow comp={comp} />

      {comp.flags.length > 0 ? (
        <ul className="flags">
          {comp.flags.map((flag, index) => (
            <li className={`flag flag-${flag.severity}`} key={`${flag.severity}-${index}`}>
              {flag.message}
            </li>
          ))}
        </ul>
      ) : (
        <p className="note">No structural problems flagged.</p>
      )}
    </section>
  );
}

/**
 * One row of the suggestion tier list.
 *
 * Win rates are only ever drawn from data that exists: `meta` is the sampled
 * aggregate, `personal` is the user's own record, and when neither is present
 * the row shows fit alone rather than inventing a number to fill the space.
 */
function SuggestionRow({
  suggestion,
  rank,
  version,
}: {
  suggestion: DraftSuggestion;
  rank: number;
  version: string | null;
}): JSX.Element {
  const meta = suggestion.meta;
  const personal = suggestion.personal;
  const id = championIdFor(suggestion.championId);
  const fit = clampPercent(suggestion.fitScore);

  return (
    <article className="tier-row" tabIndex={0}>
      <span className="tier-rank">{rank}</span>

      <ChampionPortrait championId={id} name={suggestion.name} version={version} size={48} />

      <div className="tier-body">
        <div className="tier-head">
          <span className="tier-name">{suggestion.name}</span>
          <span className="tier-fit">
            <span className="tier-fit-value">{Math.round(suggestion.fitScore)}</span>
            <span className="tier-fit-label">fit</span>
          </span>
        </div>

        <div className="bar" aria-label={`Fit score ${Math.round(suggestion.fitScore)} of 100`}>
          <div className="bar-fill" style={{ width: `${fit}%` }} />
        </div>

        {suggestion.reasons.length > 0 ? (
          <div className="chips">
            {suggestion.reasons.map((reason, index) => (
              <span className="chip" key={`${reason}-${index}`}>
                {reason}
              </span>
            ))}
          </div>
        ) : null}
      </div>

      <div className="tier-stats">
        {meta ? (
          <div className="wr-block">
            <span className="wr-caption">Patch {meta.patch}</span>
            <span className={`wr-value tone-${winRateTone(meta.winRate)}`}>
              {formatPercent(meta.winRate)}
            </span>
            <span className="wr-sample">{formatCount(meta.games)} games</span>
          </div>
        ) : null}

        {personal ? (
          <div className="wr-block wr-block--personal">
            <span className="wr-caption">Your record</span>
            <span className={`wr-value tone-${winRateTone(personal.winRate)}`}>
              {formatPercent(personal.winRate)}
            </span>
            <span className="wr-sample">
              {personal.wins}W–{personal.games - personal.wins}L in {formatCount(personal.games)}
            </span>
          </div>
        ) : null}

        {!meta && !personal ? (
          <div className="wr-block wr-block--absent">
            <span className="wr-caption">No win-rate data</span>
            <span className="wr-sample">Fit only</span>
          </div>
        ) : null}
      </div>
    </article>
  );
}

export function DraftTab({ state }: DraftTabProps): JSX.Element {
  const advice = state.draftAdvice;
  const draft = state.draft;
  const version = state.dataStatus.ddragon.patch;

  if (!advice) {
    return (
      <>
        <div className="page-head">
          <h1 className="page-title">Draft</h1>
        </div>
        <div className="empty">
          <span className="empty-title">Waiting for champion select</span>
          <span>
            The draft assistant switches on by itself as soon as you enter champ select — there is
            nothing to start here.
          </span>
          <span>
            The League client has to be running for the app to read the draft; if it is open and
            this stays empty, check the Data tab.
          </span>
        </div>
      </>
    );
  }

  const allies = draft?.allies ?? [];
  const enemies = draft?.enemies ?? [];
  const bans = draft?.bans ?? [];
  const myRole = draft?.myRole;

  return (
    <>
      <div className="page-head">
        <div className="row" style={{ gap: 10 }}>
          <h1 className="page-title">Draft</h1>
          {version ? <span className="patch-badge">patch {version}</span> : null}
          {draft?.isMyTurn ? <span className="turn-badge">your pick</span> : null}
        </div>
        <span className="page-sub">
          Comp scores rate whether a team composition functions — they are not win probabilities.
        </span>
      </div>

      {bans.length > 0 ? (
        <section className="panel ban-panel">
          <span className="panel-title">Banned</span>
          <div className="ban-strip">
            {bans.map((ban, index) => (
              <ChampionPortrait
                key={`${ban}-${index}`}
                championId={championIdFor(ban)}
                name={championNameFor(ban)}
                version={version}
                size={28}
                className="is-banned"
              />
            ))}
          </div>
        </section>
      ) : null}

      <div className="grid-2">
        <CompPanel
          title="Yours"
          subtitle={`${allies.length}/5 picked`}
          comp={advice.ally}
          picks={allies}
          version={version}
          side="ally"
        />
        <CompPanel
          title="Theirs"
          subtitle={`${enemies.length}/5 picked`}
          comp={advice.enemy}
          picks={enemies}
          version={version}
          side="enemy"
        />
      </div>

      <section className="panel">
        <div className="panel-head">
          <h2 className="panel-title">Read</h2>
        </div>
        {advice.edges.length === 0 ? (
          <p className="note">No clear edge either way yet.</p>
        ) : (
          <ul className="read-list">
            {advice.edges.map((edge, index) => (
              <li key={`${edge}-${index}`}>{edge}</li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2 className="panel-title">Suggestions</h2>
          <span className="page-sub">
            {advice.suggestions.length} picks
            {myRole ? (
              <>
                {' · for '}
                <RoleBadge role={myRole} />
              </>
            ) : null}
          </span>
        </div>
        {advice.suggestions.length === 0 ? (
          <div className="empty">
            <span className="empty-title">No suggestions for this board</span>
            <span>
              Every role is filled, or nothing in the champion table fits the remaining gap. Add
              champions to your pool in the Data tab to widen the search.
            </span>
          </div>
        ) : (
          <div className="tier-list">
            {advice.suggestions.map((suggestion, index) => (
              <SuggestionRow
                key={suggestion.championId}
                suggestion={suggestion}
                rank={index + 1}
                version={version}
              />
            ))}
          </div>
        )}
        <p className="note" style={{ marginTop: 12 }}>
          Fit score measures how well a pick fills the gaps in <strong>your</strong> comp — damage
          type, frontline, engage, peel. It is not a win rate and the two are calculated separately;
          win rates only appear when there is sampled data behind them.
        </p>
      </section>
    </>
  );
}
