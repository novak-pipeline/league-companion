import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import type { AppSettings, CompanionState } from '../../../shared/ipc.js';
import type { Lane, Role } from '../../../core/types.js';
import type { OverlayDensity } from '../../../core/cues.js';
import type { Send } from '../App';

interface DataTabProps {
  state: CompanionState;
  send: Send;
}

const LANES: Lane[] = ['top', 'mid', 'bot'];
const ROLES: Role[] = ['top', 'jungle', 'mid', 'adc', 'support'];

/**
 * Plain-language density options. The mechanism lives in `applyDensity`; this is
 * only the wording, and it is deliberately about attention rather than counts —
 * "3 cues" means nothing to a player, "you glance, you do not read" does.
 */
const DENSITY_OPTIONS: Array<{ value: OverlayDensity; label: string; hint: string }> = [
  {
    value: 'minimal',
    label: 'Minimal — one thing at a time',
    hint: 'Only the single most urgent cue is ever on screen. Best while you are learning a lane.',
  },
  {
    value: 'normal',
    label: 'Normal — one focus, a few pips',
    hint: 'One prominent cue plus a small strip of glyph-and-time pips to glance at. The default.',
  },
  {
    value: 'full',
    label: 'Full — everything the engine tracks',
    hint: 'Includes cues that are not actionable yet. Busy; better suited to the second monitor.',
  },
];

function formatTimestamp(value: string | null): string {
  if (!value) return 'never';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

function parsePool(text: string): string[] {
  return text
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

interface TextFieldProps {
  label: string;
  value: string;
  onCommit: (value: string) => void;
  placeholder?: string;
  hint?: string;
  type?: 'text' | 'password';
  /** Lets the pool field ignore pure formatting differences on echo-back. */
  isEquivalent?: (a: string, b: string) => boolean;
}

/**
 * Text input that pushes to the main process on a short debounce, so typing a
 * Riot ID does not fire one settings write per keystroke. Incoming state only
 * overwrites the box when it genuinely differs from what the user has typed.
 */
function TextField({
  label,
  value,
  onCommit,
  placeholder,
  hint,
  type = 'text',
  isEquivalent,
}: TextFieldProps): JSX.Element {
  const [local, setLocal] = useState(value);
  const localRef = useRef(value);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    const same = isEquivalent ? isEquivalent(value, localRef.current) : value === localRef.current;
    if (!same) {
      localRef.current = value;
      setLocal(value);
    }
    // Deliberately keyed on `value` alone: re-running this on every render
    // would wipe out what the user is mid-way through typing.
  }, [value]);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const handleChange = (next: string): void => {
    localRef.current = next;
    setLocal(next);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => onCommit(next), 350);
  };

  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <input
        type={type}
        value={local}
        placeholder={placeholder}
        onChange={(event) => handleChange(event.target.value)}
        onBlur={() => {
          window.clearTimeout(timer.current);
          onCommit(localRef.current);
        }}
      />
      {hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}

function StatusCard({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  return (
    <div className="status-card">
      <h4>{title}</h4>
      <dl style={{ margin: 0 }}>{children}</dl>
    </div>
  );
}

function Row({ label, value }: { label: string; value: ReactNode }): JSX.Element {
  return (
    <div className="kv">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

export function DataTab({ state, send }: DataTabProps): JSX.Element {
  const { dataStatus, settings, jobStatus } = state;
  const [importCount, setImportCount] = useState(20);
  const [keyResult, setKeyResult] = useState<boolean | null>(null);
  const [apiKeyDraft, setApiKeyDraft] = useState('');

  const busy = jobStatus.job !== null;

  const patch = (next: Partial<AppSettings>): void => {
    void send('settings:update', next);
  };

  /** Rebuild the riot block without `hasApiKey`, which is renderer-only. */
  const riotPatch = (next: { platform?: string; riotId?: string; apiKey?: string }): void => {
    const riot: AppSettings['riot'] = {
      platform: next.platform ?? settings.riot.platform,
      riotId: next.riotId ?? settings.riot.riotId,
    };
    if (next.apiKey !== undefined) riot.apiKey = next.apiKey;
    patch({ riot });
  };

  const overlayPatch = (next: Partial<AppSettings['overlay']>): void => {
    patch({ overlay: { ...settings.overlay, ...next } });
  };

  const progress =
    jobStatus.total > 0 ? Math.min(100, (jobStatus.done / jobStatus.total) * 100) : 0;

  const densityHint =
    DENSITY_OPTIONS.find((option) => option.value === settings.overlay.density)?.hint ??
    'Controls how many cues the overlay is allowed to show at once.';

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Data</h1>
        <span className="page-sub">Where every number in this app comes from</span>
      </div>

      <section className="panel">
        <div className="panel-head">
          <h2 className="panel-title">Sources</h2>
        </div>
        <div className="status-grid">
          <StatusCard title="Data Dragon (champions)">
            <Row label="Patch" value={dataStatus.ddragon.patch ?? '—'} />
            <Row label="Champions" value={dataStatus.ddragon.championCount} />
            <Row label="Updated" value={formatTimestamp(dataStatus.ddragon.updatedAt)} />
            <Row
              label="Status"
              value={
                <span className={`badge ${dataStatus.ddragon.ok ? 'tone-good' : 'tone-bad'}`}>
                  {dataStatus.ddragon.ok ? 'ok' : 'stale'}
                </span>
              }
            />
          </StatusCard>

          <StatusCard title="Meta sample">
            <Row label="Patch" value={dataStatus.meta.patch ?? '—'} />
            <Row label="Sample size" value={`${dataStatus.meta.sampleSize} matches`} />
            <Row label="Updated" value={formatTimestamp(dataStatus.meta.updatedAt)} />
            <Row label="Source" value={dataStatus.meta.source} />
          </StatusCard>

          <StatusCard title="Riot API">
            <Row
              label="Configured"
              value={
                <span className={`badge ${dataStatus.riotApi.configured ? 'tone-good' : 'tone-warn'}`}>
                  {dataStatus.riotApi.configured ? 'yes' : 'no'}
                </span>
              }
            />
            <Row label="Last error" value={dataStatus.riotApi.lastError ?? 'none'} />
            {keyResult === null ? null : (
              <Row
                label="Key check"
                value={
                  <span className={`badge ${keyResult ? 'tone-good' : 'tone-bad'}`}>
                    {keyResult ? 'valid' : 'rejected'}
                  </span>
                }
              />
            )}
          </StatusCard>

          <StatusCard title="Your matches">
            <Row label="Stored games" value={dataStatus.personalMatches} />
            <Row label="Connection" value={state.mode} />
          </StatusCard>
        </div>

        <p className="note note-strong" style={{ marginTop: 14 }}>
          Aggregate win rates are built from ranked matches this app samples locally through the
          official Riot API. They start empty and the sample size grows as collection runs — nothing
          is scraped from third-party sites, and no number is shown before there is data behind it.
        </p>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2 className="panel-title">Actions</h2>
        </div>
        <div className="row">
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => void send('data:refreshDDragon')}
          >
            Refresh champion data
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => void send('data:collectMeta')}
          >
            Collect meta sample
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy || importCount <= 0}
            onClick={() => void send('data:importHistory', Math.round(importCount))}
          >
            Import match history
          </button>
          <input
            type="number"
            min={1}
            max={200}
            step={1}
            value={importCount}
            aria-label="Matches to import"
            onChange={(event) => setImportCount(Number(event.target.value))}
            style={{ width: 90 }}
          />
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => {
              setKeyResult(null);
              void send('data:verifyKey').then(
                (ok) => setKeyResult(ok),
                () => setKeyResult(false),
              );
            }}
          >
            Verify API key
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => void send('demo:toggle', state.mode !== 'demo')}
          >
            {state.mode === 'demo' ? 'Leave demo mode' : 'Toggle demo mode'}
          </button>
        </div>

        {jobStatus.job === null ? null : (
          <div className="stack" style={{ marginTop: 14, gap: 6 }}>
            <div className="metric-foot">
              <span>
                {jobStatus.job}: {jobStatus.message}
              </span>
              <span>
                {jobStatus.done} / {jobStatus.total}
              </span>
            </div>
            <div
              className="progress"
              role="progressbar"
              aria-valuenow={jobStatus.done}
              aria-valuemin={0}
              aria-valuemax={jobStatus.total}
            >
              <div className="progress-fill" style={{ width: `${progress}%` }} />
            </div>
          </div>
        )}
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2 className="panel-title">Settings</h2>
        </div>
        <div className="form-grid">
          <label className="field">
            <span className="field-label">Lane</span>
            <select
              value={settings.lane}
              onChange={(event) => patch({ lane: event.target.value as Lane })}
            >
              {LANES.map((lane) => (
                <option key={lane} value={lane}>
                  {lane}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span className="field-label">Role</span>
            <select
              value={settings.role}
              onChange={(event) => patch({ role: event.target.value as Role })}
            >
              {ROLES.map((role) => (
                <option key={role} value={role}>
                  {role}
                </option>
              ))}
            </select>
          </label>

          <TextField
            label="Champion pool"
            value={settings.championPool.join(', ')}
            hint="Comma separated, e.g. Ahri, Orianna, Syndra"
            isEquivalent={(a, b) => parsePool(a).join('|') === parsePool(b).join('|')}
            onCommit={(text) => patch({ championPool: parsePool(text) })}
          />

          <TextField
            label="Riot platform"
            value={settings.riot.platform}
            hint="e.g. euw1, na1, kr"
            onCommit={(value) => riotPatch({ platform: value.trim() })}
          />

          <TextField
            label="Riot ID"
            value={settings.riot.riotId}
            placeholder="Name#TAG"
            onCommit={(value) => riotPatch({ riotId: value.trim() })}
          />

          <label className="field">
            <span className="field-label">Riot API key</span>
            <input
              type="password"
              value={apiKeyDraft}
              placeholder={settings.riot.hasApiKey ? '•••• stored' : 'paste your key'}
              onChange={(event) => {
                setApiKeyDraft(event.target.value);
                riotPatch({ apiKey: event.target.value });
              }}
            />
            <span className="field-hint">
              Stored by the main process only — it is never sent back to this window.
            </span>
          </label>
        </div>

        <div className="panel-head" style={{ marginTop: 20 }}>
          <h2 className="panel-title">Overlay</h2>
          <span className="page-sub">
            {state.overlayCues.length} of {state.cues.length} cues currently on screen
          </span>
        </div>
        <div className="form-grid">
          <label className="field field-inline">
            <input
              type="checkbox"
              checked={settings.overlay.enabled}
              onChange={(event) => overlayPatch({ enabled: event.target.checked })}
            />
            <span className="field-label">Overlay enabled</span>
          </label>

          <label className="field field-wide">
            <span className="field-label">Overlay density — how much shows on screen at once</span>
            <select
              value={settings.overlay.density}
              onChange={(event) => {
                void send('settings:update', {
                  overlay: { ...settings.overlay, density: event.target.value as OverlayDensity },
                });
              }}
            >
              {DENSITY_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <span className="field-hint">{densityHint}</span>
          </label>

          <label className="field">
            <span className="field-label">Opacity — {settings.overlay.opacity.toFixed(2)}</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={settings.overlay.opacity}
              onChange={(event) => overlayPatch({ opacity: Number(event.target.value) })}
            />
          </label>

          <label className="field">
            <span className="field-label">Scale — {settings.overlay.scale.toFixed(2)}×</span>
            <input
              type="range"
              min={0.5}
              max={2}
              step={0.05}
              value={settings.overlay.scale}
              onChange={(event) => overlayPatch({ scale: Number(event.target.value) })}
            />
          </label>

          <label className="field">
            <span className="field-label">Cue horizon (seconds)</span>
            <input
              type="number"
              min={0}
              step={5}
              value={settings.overlay.horizonSeconds}
              onChange={(event) => overlayPatch({ horizonSeconds: Number(event.target.value) })}
            />
            <span className="field-hint">How far ahead cues appear.</span>
          </label>
        </div>
      </section>
    </>
  );
}
