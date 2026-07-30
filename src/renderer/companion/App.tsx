import { useEffect, useMemo, useState } from 'react';

import type {
  CommandName,
  CompanionCommands,
  CompanionState,
  ConnectionMode,
} from '../../shared/ipc.js';

import { LiveTab } from './tabs/LiveTab';
import { DraftTab } from './tabs/DraftTab';
import { TrendsTab } from './tabs/TrendsTab';
import { DataTab } from './tabs/DataTab';

/**
 * Command dispatcher handed down to the tabs. Wrapping `window.companion.send`
 * keeps the bridge lookup in one place and keeps the tabs testable as plain
 * components that take a function.
 */
export type Send = <K extends CommandName>(
  name: K,
  ...args: Parameters<CompanionCommands[K]>
) => ReturnType<CompanionCommands[K]>;

const send: Send = (name, ...args) => window.companion.send(name, ...args);

const TABS = [
  { id: 'live', label: 'Live' },
  { id: 'draft', label: 'Draft' },
  { id: 'trends', label: 'Trends' },
  { id: 'data', label: 'Data' },
] as const;

type TabId = (typeof TABS)[number]['id'];

const MODE_LABEL: Record<ConnectionMode, string> = {
  idle: 'Idle',
  live: 'Live',
  demo: 'Demo',
};

/** Seconds -> MM:SS. Negative values clamp to zero. */
function formatClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export function App(): JSX.Element {
  const [state, setState] = useState<CompanionState | null>(null);
  const [tab, setTab] = useState<TabId>('live');
  const [dismissed, setDismissed] = useState<string[]>([]);

  useEffect(() => window.companion.onState(setState), []);

  const notices = state?.notices;
  const visibleNotices = useMemo(
    () => (notices ?? []).filter((notice) => !dismissed.includes(notice)),
    [notices, dismissed],
  );

  // Drop dismissals for notices the main process has since resolved, so a
  // recurring problem shows up again rather than staying silently hidden.
  useEffect(() => {
    if (!notices) return;
    setDismissed((prev) => {
      const kept = prev.filter((notice) => notices.includes(notice));
      return kept.length === prev.length ? prev : kept;
    });
  }, [notices]);

  if (!state) {
    return (
      <div className="app">
        <div className="content">
          <div className="empty">
            <span className="empty-title">Connecting to the companion service…</span>
            <span>Waiting for the first state push from the main process.</span>
          </div>
        </div>
      </div>
    );
  }

  const snapshot = state.snapshot;

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-title">Companion</span>
          <span className="brand-sub">Second-screen dashboard</span>
        </div>

        <nav className="nav">
          {TABS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className={`nav-item${tab === entry.id ? ' is-active' : ''}`}
              onClick={() => setTab(entry.id)}
              aria-current={tab === entry.id ? 'page' : undefined}
            >
              <span>{entry.label}</span>
              {entry.id === 'live' && state.cues.length > 0 ? (
                <span className="nav-count">{state.cues.length}</span>
              ) : null}
              {entry.id === 'draft' && state.draft?.isMyTurn ? (
                <span className="nav-count nav-count--live" title="It is your pick">
                  ●
                </span>
              ) : null}
              {entry.id === 'data' && state.notices.length > 0 ? (
                <span className="nav-count nav-count--warn">{state.notices.length}</span>
              ) : null}
            </button>
          ))}
        </nav>

        <div className="sidebar-foot">
          <span className={`pill mode-${state.mode}`} title={`Connection: ${state.mode}`}>
            <span className="pill-dot" />
            {MODE_LABEL[state.mode]}
          </span>
          {snapshot ? (
            <div className="clock">
              <span className="clock-label">Clock</span>
              <span className="clock-value">{formatClock(snapshot.gameTime)}</span>
            </div>
          ) : null}
          <span className="brand-sub" title="Data Dragon patch backing champion art and data">
            {state.dataStatus.ddragon.patch
              ? `Patch ${state.dataStatus.ddragon.patch}`
              : 'Patch unknown — offline'}
          </span>
        </div>
      </aside>

      <main className="content">
        {visibleNotices.length > 0 ? (
          <div className="notices">
            {visibleNotices.map((notice) => (
              <div className="notice" key={notice} role="status">
                <span aria-hidden="true">⚠</span>
                <span className="notice-text">{notice}</span>
                <button
                  type="button"
                  className="notice-close"
                  aria-label="Dismiss notice"
                  onClick={() => setDismissed((prev) => [...prev, notice])}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        ) : null}

        {tab === 'live' ? <LiveTab state={state} send={send} /> : null}
        {tab === 'draft' ? <DraftTab state={state} /> : null}
        {tab === 'trends' ? <TrendsTab state={state} /> : null}
        {tab === 'data' ? <DataTab state={state} send={send} /> : null}
      </main>
    </div>
  );
}
