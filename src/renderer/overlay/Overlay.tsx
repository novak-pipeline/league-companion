import { useEffect, useState } from 'react';
import type { CSSProperties, ReactElement } from 'react';
import type { Cue } from '../../core/types.js';
import type { CompanionState } from '../../shared/ipc.js';
import { cueGlyph } from '../shared/cueGlyphs';

/**
 * The in-game overlay.
 *
 * Focus + periphery, not a list. A player mid-teamfight has no spare attention
 * for a wall of countdowns; if the overlay asks to be *read* it gets ignored
 * entirely, which is worse than showing nothing. So exactly one cue is allowed
 * to look important — `overlayCues[0]`, the thing to act on now — and everything
 * else collapses into a low-contrast strip of glyph+time pips that can be
 * glanced at without parsing. Anything merely informational belongs on the
 * companion window, on the second monitor.
 *
 * The input is `state.overlayCues`, already built, filtered to the user's
 * density setting and sorted by the main process. This file adds no cue logic.
 *
 * Invariants worth keeping:
 *  - never re-sort, re-filter or re-derive cues; the main process is authoritative
 *  - severity changes colour and weight only, never size, padding or position,
 *    or the card jitters as it re-renders 10x a second
 *  - at most one animated element on screen, and none under reduced motion
 *  - render nothing at all when there is nothing to act on, so the window is
 *    genuinely invisible rather than merely quiet
 */

/** How often the interpolated countdowns are recomputed. */
const TICK_MS = 100;

const NO_CUES: readonly Cue[] = [];

/** The latest push, plus the wall-clock instant it landed. */
interface StatePush {
  state: CompanionState;
  receivedAt: number;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** `M:SS` for a countdown; "NOW" once it reaches zero or is already live. */
function formatCountdown(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return 'NOW';
  const total = Math.ceil(seconds);
  if (total <= 0) return 'NOW';
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${minutes}:${String(rest).padStart(2, '0')}`;
}

function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/** Seconds left on a cue, interpolated forward from the push it arrived in. */
function remainingFor(cue: Cue, elapsedSeconds: number): number | null {
  if (cue.etaSeconds === null) return null;
  return Math.max(0, cue.etaSeconds - elapsedSeconds);
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

/** Subscribes to main-process state pushes for the lifetime of the window. */
function useCompanionState(): StatePush | null {
  const [push, setPush] = useState<StatePush | null>(null);

  useEffect(() => {
    const bridge = window.companion;
    if (!bridge) return undefined;
    return bridge.onState((state) => {
      setPush({ state, receivedAt: Date.now() });
    });
  }, []);

  return push;
}

/**
 * A wall clock that advances every {@link TICK_MS} while `active`. Countdowns
 * are derived from it so they keep falling between state pushes instead of
 * stepping once a second.
 */
function useNowMs(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active) return undefined;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(id);
  }, [active]);

  return now;
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

interface CueProps {
  cue: Cue;
  /** Seconds elapsed since the state push this cue came from. */
  elapsedSeconds: number;
}

/**
 * The one thing allowed to catch the eye: glyph, short label, large countdown.
 *
 * `cue.detail` is deliberately dropped. It is context ("Wave 7 · arrives 5:20"),
 * and context is a second-monitor concern — reading it costs a beat the player
 * does not have.
 */
function PrimaryCue({ cue, elapsedSeconds }: CueProps): ReactElement {
  const remaining = remainingFor(cue, elapsedSeconds);

  return (
    <div className={`focus-cue focus-cue--${cue.severity}`} role="status" aria-live="off">
      <span className="focus-cue__glyph" aria-hidden="true">
        {cueGlyph(cue.kind)}
      </span>
      <span className="focus-cue__label">{cue.label}</span>
      <span className="focus-cue__eta">{formatCountdown(remaining)}</span>
    </div>
  );
}

/**
 * Periphery: glyph and time, nothing else. No label, low contrast, fixed width
 * so the strip never reflows as the digits change.
 */
function PeripheryPip({ cue, elapsedSeconds }: CueProps): ReactElement {
  const remaining = remainingFor(cue, elapsedSeconds);

  return (
    <span className={`pip pip--${cue.severity}`} title={cue.label}>
      <span className="pip__glyph" aria-hidden="true">
        {cueGlyph(cue.kind)}
      </span>
      <span className="pip__eta">{formatCountdown(remaining)}</span>
    </span>
  );
}

export function Overlay(): ReactElement | null {
  const push = useCompanionState();
  const state = push?.state ?? null;

  // `overlayCues`, not `cues`: the main process has already trimmed this to the
  // user's density setting so both windows agree and no cue logic lives here.
  const cues = state?.overlayCues ?? NO_CUES;

  // Only burn a timer while something is actually counting down.
  const needsTicker = cues.some((cue) => cue.etaSeconds !== null);
  const nowMs = useNowMs(needsTicker);

  if (!push || !state) return null;

  const overlay = state.settings.overlay;
  if (overlay.enabled === false) return null;

  // Nothing to act on: be completely invisible, not merely quiet.
  const primary = cues[0];
  if (!primary) return null;

  const periphery = cues.slice(1);
  const elapsedSeconds = needsTicker ? Math.max(0, (nowMs - push.receivedAt) / 1000) : 0;

  const rootStyle: CSSProperties = {
    opacity: clamp(overlay.opacity, 0, 1, 1),
    transform: `scale(${clamp(overlay.scale, 0.5, 3, 1)})`,
  };

  return (
    <div className="overlay-root" style={rootStyle}>
      <PrimaryCue cue={primary} elapsedSeconds={elapsedSeconds} />

      {periphery.length > 0 ? (
        <div className="periphery">
          {periphery.map((cue) => (
            <PeripheryPip key={cue.id} cue={cue} elapsedSeconds={elapsedSeconds} />
          ))}
        </div>
      ) : null}

      {state.mode === 'demo' ? <span className="overlay-badge">demo</span> : null}
    </div>
  );
}
