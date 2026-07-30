import { useState } from 'react';

import type { CompanionState } from '../../../shared/ipc.js';
import type { Cue, ManualTimer, PlayerState, Team } from '../../../core/types.js';
import type { Send } from '../App';

import { ChampionPortrait } from '../../shared/ChampionPortrait';
import { RoleBadgeSlot } from '../../shared/RoleBadge';
import { championIdFor, championNameFor } from '../../shared/champions';
import { cueGlyph } from '../../shared/cueGlyphs';
import { formatDuration, round } from '../../shared/format';

interface LiveTabProps {
  state: CompanionState;
  send: Send;
}

const SCUTTLE_SECONDS = 150;

/** Seconds -> M:SS, clamped at zero. "NOW" for a cue that is already live. */
function formatEta(seconds: number | null): string {
  if (seconds === null) return 'NOW';
  return formatDuration(seconds);
}

/**
 * Remaining time on a user-started timer, relative to the live game clock.
 * Null when there is no clock to measure against.
 */
function timerRemaining(timer: ManualTimer, gameTime: number | null): number | null {
  if (gameTime === null) return null;
  return timer.startedAtGameTime + timer.durationSeconds - gameTime;
}

/** KDA ratio, with a perfect game reported as such rather than as Infinity. */
function kdaRatio(player: PlayerState): string {
  if (player.deaths === 0) {
    return player.kills + player.assists === 0 ? '0.00' : 'Perfect';
  }
  return ((player.kills + player.assists) / player.deaths).toFixed(2);
}

function CueRow({ cue }: { cue: Cue }): JSX.Element {
  return (
    <li className={`cue sev-${cue.severity}`}>
      <span className="cue-glyph" aria-hidden="true">
        {cueGlyph(cue.kind)}
      </span>
      <div className="cue-body">
        <div className="cue-label">{cue.label}</div>
        {cue.detail ? <div className="cue-detail">{cue.detail}</div> : null}
      </div>
      <span className="cue-kind">{cue.lane ? `${cue.kind} · ${cue.lane}` : cue.kind}</span>
      <span className="cue-eta">{formatEta(cue.etaSeconds)}</span>
    </li>
  );
}

function ScoreboardTable({
  team,
  players,
  self,
  version,
  gameTime,
}: {
  team: Team;
  players: PlayerState[];
  self: PlayerState | null;
  version: string | null;
  gameTime: number | null;
}): JSX.Element {
  const minutes = gameTime !== null && gameTime > 0 ? gameTime / 60 : null;

  return (
    <div className="panel">
      <div className="team-head">
        <span className={`team-name ${team === 'ORDER' ? 'team-order' : 'team-chaos'}`}>{team}</span>
        <span className="page-sub">{players.length} players</span>
      </div>
      <div className="table-wrap">
        <table className="scoreboard">
          <thead>
            <tr>
              <th>Champion</th>
              <th className="col-role">Role</th>
              <th>Summoner</th>
              <th className="num">K / D / A</th>
              <th className="num">KDA</th>
              <th className="num">CS</th>
              <th className="num">CS/m</th>
              <th className="num">Lvl</th>
            </tr>
          </thead>
          <tbody>
            {players.length === 0 ? (
              <tr>
                <td colSpan={8} className="table-empty">
                  No players reported.
                </td>
              </tr>
            ) : (
              players.map((player, index) => {
                const isSelf = self !== null && player.summonerName === self.summonerName;
                const championId = championIdFor(player.championName);
                const championName = championNameFor(player.championName);
                const csPerMin = minutes ? round(player.creepScore / minutes, 1) : null;

                return (
                  <tr
                    key={`${player.summonerName}-${index}`}
                    className={`${isSelf ? 'self-row' : ''}${player.isDead ? ' dead-row' : ''}`}
                  >
                    <td>
                      <div className="champ-cell">
                        <ChampionPortrait
                          championId={championId}
                          name={championName}
                          version={version}
                          size={28}
                          className={player.isDead ? 'is-dead' : undefined}
                        />
                        <span className="champ-cell-name">{championName}</span>
                        {isSelf ? <span className="self-tag">you</span> : null}
                        {player.isDead ? (
                          <span className="respawn" title="Respawning">
                            {formatDuration(player.respawnTimer)}
                          </span>
                        ) : null}
                      </div>
                    </td>
                    <td className="col-role">
                      <RoleBadgeSlot role={player.position} />
                    </td>
                    <td className="summoner-cell">{player.summonerName}</td>
                    <td className="num">
                      {player.kills} / {player.deaths} / {player.assists}
                    </td>
                    <td className="num">{kdaRatio(player)}</td>
                    <td className="num">{player.creepScore}</td>
                    <td className="num dim-cell">{csPerMin === null ? '—' : csPerMin.toFixed(1)}</td>
                    <td className="num">{player.level}</td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function LiveTab({ state, send }: LiveTabProps): JSX.Element {
  const [customLabel, setCustomLabel] = useState('Custom');
  const [customSeconds, setCustomSeconds] = useState(60);

  const snapshot = state.snapshot;
  const gameTime = snapshot?.gameTime ?? null;
  const version = state.dataStatus.ddragon.patch;
  // The cue engine already orders these: live cues first, then by urgency.
  // Re-sorting by sortKey would bury a "NOW" cue under a one-minute countdown.
  const cues = state.cues;
  const order = snapshot ? snapshot.players.filter((p) => p.team === 'ORDER') : [];
  const chaos = snapshot ? snapshot.players.filter((p) => p.team === 'CHAOS') : [];

  // What the overlay is actually showing right now, so the density setting is
  // legible without alt-tabbing into a game.
  const onOverlay = state.overlayCues.length;

  const startTimer = (label: string, kind: ManualTimer['kind'], durationSeconds: number): void => {
    void send('timer:start', {
      label,
      kind,
      startedAtGameTime: snapshot?.gameTime ?? 0,
      durationSeconds,
    });
  };

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Live</h1>
        <span className="page-sub">
          {snapshot
            ? `${snapshot.gameMode} · ${snapshot.mapName}`
            : 'No game detected — cues appear once a game is running.'}
        </span>
      </div>

      <section className="panel">
        <div className="panel-head">
          <h2 className="panel-title">Cues</h2>
          <span className="page-sub">
            {cues.length} tracked · {onOverlay} on the overlay
          </span>
        </div>
        {cues.length === 0 ? (
          <div className="empty">
            <span className="empty-title">Nothing to call yet</span>
            <span>Wave, objective and reminder cues show up here while a game is live.</span>
            <span>
              Not in a game? Switch on demo mode from the <strong>Data</strong> tab to see how this
              looks.
            </span>
          </div>
        ) : (
          <ul className="cue-list">
            {cues.map((cue) => (
              <CueRow key={cue.id} cue={cue} />
            ))}
          </ul>
        )}
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2 className="panel-title">Manual timers</h2>
          {state.manualTimers.length > 0 ? (
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => void send('timer:clearAll')}
            >
              Clear all
            </button>
          ) : null}
        </div>

        <p className="note note-strong">
          Riot&apos;s API does not expose scuttle respawns or enemy summoner cooldowns, and
          auto-tracking them would break Riot&apos;s third-party policy — these timers only ever
          start when you press the button.
        </p>

        <div className="row" style={{ marginTop: 12 }}>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => startTimer('Scuttle', 'scuttle', SCUTTLE_SECONDS)}
          >
            Start scuttle ({SCUTTLE_SECONDS}s)
          </button>
          <input
            type="text"
            value={customLabel}
            aria-label="Custom timer label"
            onChange={(event) => setCustomLabel(event.target.value)}
            style={{ width: 160 }}
          />
          <input
            type="number"
            min={1}
            step={1}
            value={customSeconds}
            aria-label="Custom timer seconds"
            onChange={(event) => setCustomSeconds(Number(event.target.value))}
            style={{ width: 90 }}
          />
          <button
            type="button"
            className="btn"
            disabled={customSeconds <= 0 || customLabel.trim() === ''}
            onClick={() =>
              startTimer(customLabel.trim() || 'Custom', 'custom', Math.round(customSeconds))
            }
          >
            Start custom
          </button>
        </div>

        <div className="timer-list" style={{ marginTop: 12 }}>
          {state.manualTimers.length === 0 ? (
            <p className="note">No timers running.</p>
          ) : (
            state.manualTimers.map((timer) => {
              const remaining = timerRemaining(timer, gameTime);
              return (
                <div className="timer-item" key={timer.id}>
                  <span className="timer-name">{timer.label}</span>
                  <span className="timer-meta">
                    {timer.kind}
                    {timer.lane ? ` · ${timer.lane}` : ''} · {timer.durationSeconds}s from{' '}
                    {formatEta(timer.startedAtGameTime)}
                  </span>
                  <span className="spacer" />
                  <span className="timer-remaining">
                    {remaining === null ? '—' : remaining <= 0 ? 'NOW' : formatEta(remaining)}
                  </span>
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    onClick={() => void send('timer:clear', timer.id)}
                  >
                    Clear
                  </button>
                </div>
              );
            })
          )}
        </div>
      </section>

      <section>
        <div className="panel-head">
          <h2 className="panel-title">Scoreboard</h2>
        </div>
        {snapshot === null ? (
          <div className="empty">
            <span className="empty-title">No live game</span>
            <span>
              Start a game (or switch on demo mode from the Data tab) to populate the scoreboard.
            </span>
          </div>
        ) : (
          <div className="grid-2">
            <ScoreboardTable
              team="ORDER"
              players={order}
              self={snapshot.self}
              version={version}
              gameTime={gameTime}
            />
            <ScoreboardTable
              team="CHAOS"
              players={chaos}
              self={snapshot.self}
              version={version}
              gameTime={gameTime}
            />
          </div>
        )}
      </section>
    </>
  );
}
