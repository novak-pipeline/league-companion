import { useMemo, useState } from 'react';

import type { CompanionState } from '../../../shared/ipc.js';
import type { MetricSummary, TrendReport } from '../../../core/types.js';

import { ChampionPortrait } from '../../shared/ChampionPortrait';
import { championIdFor, championNameFor } from '../../shared/champions';
import { clampPercent, formatPercent, round, winRateTone } from '../../shared/format';

interface TrendsTabProps {
  state: CompanionState;
}

type BreakdownRow = TrendReport['championBreakdown'][number];
type SortKey = 'champion' | 'games' | 'winRate' | 'avgKda' | 'avgCsPerMin';
type SortDir = 'asc' | 'desc';

const COLUMNS: Array<{ key: SortKey; label: string; numeric: boolean }> = [
  { key: 'champion', label: 'Champion', numeric: false },
  { key: 'games', label: 'Games', numeric: true },
  { key: 'winRate', label: 'Win rate', numeric: true },
  { key: 'avgKda', label: 'Avg KDA', numeric: true },
  { key: 'avgCsPerMin', label: 'CS/min', numeric: true },
];

/**
 * Under this many games a personal win rate is mostly variance. It is still
 * shown — it is the user's own record and hiding it would be strange — but the
 * colour is withheld so a 100% on two games does not read as a strength.
 */
const THIN_SAMPLE = 5;

/**
 * Green when the metric clears its target, amber when it is within 15% of it,
 * red otherwise. `higherIsBetter` flips the comparison for things like deaths.
 */
function metricTone(metric: MetricSummary): 'good' | 'warn' | 'bad' {
  const { value, target, higherIsBetter } = metric;
  const beatsTarget = higherIsBetter ? value >= target : value <= target;
  if (beatsTarget) return 'good';
  if (target === 0) return 'bad';
  const shortfall = higherIsBetter ? (target - value) / target : (value - target) / target;
  return shortfall <= 0.15 ? 'warn' : 'bad';
}

/** An improving trend depends on which direction is good for the metric. */
function trendTone(metric: MetricSummary, trend: number): 'good' | 'bad' | undefined {
  if (trend === 0) return undefined;
  const improving = metric.higherIsBetter ? trend > 0 : trend < 0;
  return improving ? 'good' : 'bad';
}

/** Where the value sits between zero and 130% of target, for the progress rail. */
function targetProgress(metric: MetricSummary): number {
  if (!Number.isFinite(metric.target) || metric.target <= 0) return 0;
  return clampPercent((metric.value / (metric.target * 1.3)) * 100);
}

function MetricCard({ metric }: { metric: MetricSummary }): JSX.Element {
  const tone = metricTone(metric);
  const trend = metric.trend;
  const arrowTone = trend === null ? undefined : trendTone(metric, trend);

  return (
    <div className="metric">
      <span className="metric-label">{metric.label}</span>
      <span className={`metric-value tone-${tone}`}>
        {round(metric.value, 2)}
        {metric.unit ? <span className="metric-unit"> {metric.unit}</span> : null}
      </span>

      <div className="mini-bar" aria-hidden="true">
        <div
          className={`mini-bar-fill tone-fill-${tone}`}
          style={{ width: `${targetProgress(metric)}%` }}
        />
        <div
          className="mini-bar-target"
          style={{ left: `${metric.target > 0 ? 100 / 1.3 : 0}%` }}
          title={`Target ${round(metric.target, 2)}`}
        />
      </div>

      <div className="metric-foot">
        <span>
          target {round(metric.target, 2)}
          {metric.unit ? ` ${metric.unit}` : ''}
        </span>
        {trend === null ? (
          <span className="metric-trend-empty" title="Not enough games to compare yet">
            no trend
          </span>
        ) : (
          <span className={arrowTone ? `tone-${arrowTone}` : undefined}>
            {trend > 0 ? '▲' : trend < 0 ? '▼' : '•'} {round(Math.abs(trend), 2)}
          </span>
        )}
      </div>
    </div>
  );
}

export function TrendsTab({ state }: TrendsTabProps): JSX.Element {
  const trends = state.trends;
  const version = state.dataStatus.ddragon.patch;
  const [sortKey, setSortKey] = useState<SortKey>('games');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  const rows = useMemo<BreakdownRow[]>(() => {
    const copy = [...trends.championBreakdown];
    const factor = sortDir === 'asc' ? 1 : -1;
    copy.sort((a, b) => {
      if (sortKey === 'champion') return a.champion.localeCompare(b.champion) * factor;
      return (a[sortKey] - b[sortKey]) * factor;
    });
    return copy;
  }, [trends.championBreakdown, sortKey, sortDir]);

  const toggleSort = (key: SortKey): void => {
    if (key === sortKey) {
      setSortDir((dir) => (dir === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir(key === 'champion' ? 'asc' : 'desc');
    }
  };

  if (trends.gamesAnalyzed === 0) {
    return (
      <>
        <div className="page-head">
          <h1 className="page-title">Trends</h1>
        </div>
        <div className="empty">
          <span className="empty-title">No games analyzed yet</span>
          <span>
            Trends are built from your own stored games. Open the <strong>Data</strong> tab and run
            &ldquo;Import match history&rdquo; to seed it, or just play a game with the companion
            running.
          </span>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Trends</h1>
        <span className="page-sub">{trends.gamesAnalyzed} games analyzed</span>
      </div>

      <section className="panel">
        <div className="panel-head">
          <h2 className="panel-title">Metrics</h2>
          <span className="page-sub">Bars are scaled against your target, marked on the rail</span>
        </div>
        {trends.metrics.length === 0 ? (
          <p className="note">No metrics available for this window.</p>
        ) : (
          <div className="grid-cards">
            {trends.metrics.map((metric) => (
              <MetricCard key={metric.label} metric={metric} />
            ))}
          </div>
        )}
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2 className="panel-title">Work on this</h2>
        </div>
        {trends.focusAreas.length === 0 ? (
          <p className="note">Nothing is falling short of target right now.</p>
        ) : (
          <ol className="focus-list">
            {trends.focusAreas.map((area, index) => (
              <li key={`${area}-${index}`}>{area}</li>
            ))}
          </ol>
        )}
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2 className="panel-title">Champions</h2>
          <span className="page-sub">Click a header to sort</span>
        </div>
        <div className="table-wrap">
          <table className="champ-table">
            <thead>
              <tr>
                {COLUMNS.map((column) => (
                  <th
                    key={column.key}
                    className={`sortable${column.numeric ? ' num' : ''}`}
                    tabIndex={0}
                    role="columnheader"
                    onClick={() => toggleSort(column.key)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        toggleSort(column.key);
                      }
                    }}
                    aria-sort={
                      sortKey === column.key
                        ? sortDir === 'asc'
                          ? 'ascending'
                          : 'descending'
                        : 'none'
                    }
                  >
                    {column.label}
                    {sortKey === column.key ? (
                      <span className="sort-arrow">{sortDir === 'asc' ? '▲' : '▼'}</span>
                    ) : null}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={COLUMNS.length} className="table-empty">
                    No champion data yet.
                  </td>
                </tr>
              ) : (
                rows.map((row) => {
                  const thin = row.games < THIN_SAMPLE;
                  const tone = thin ? 'neutral' : winRateTone(row.winRate);
                  return (
                    <tr key={row.champion}>
                      <td>
                        <div className="champ-cell">
                          <ChampionPortrait
                            championId={championIdFor(row.champion)}
                            name={championNameFor(row.champion)}
                            version={version}
                            size={28}
                          />
                          <span className="champ-cell-name">
                            {championNameFor(row.champion)}
                          </span>
                        </div>
                      </td>
                      <td className="num">
                        {row.games}
                        <span className="record">
                          {row.wins}W–{row.games - row.wins}L
                        </span>
                      </td>
                      <td className="num">
                        <span className={`wr-inline tone-${tone}`}>
                          {formatPercent(row.winRate)}
                        </span>
                        <span
                          className="wr-rail"
                          aria-hidden="true"
                          title={thin ? 'Sample too small to read into' : undefined}
                        >
                          <span
                            className={`wr-rail-fill tone-fill-${tone}`}
                            style={{ width: `${clampPercent(row.winRate)}%` }}
                          />
                        </span>
                      </td>
                      <td className="num">{round(row.avgKda, 2).toFixed(2)}</td>
                      <td className="num">{round(row.avgCsPerMin, 2).toFixed(2)}</td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
        <p className="note" style={{ marginTop: 12 }}>
          Win rate is coloured against the 48% / 52% band. Champions with fewer than {THIN_SAMPLE}{' '}
          games stay grey — the sample is too small to mean anything.
        </p>
      </section>
    </>
  );
}
