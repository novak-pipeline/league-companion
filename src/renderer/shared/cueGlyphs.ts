import type { CueKind } from '../../core/types.js';

/**
 * One glyph per cue kind, shared by the overlay and the companion window so a
 * symbol means the same thing on both screens. Unicode only — nothing to load,
 * and it survives the overlay's `img-src`-restricted CSP.
 */
const KIND_GLYPHS: Record<CueKind, string> = {
  // Derived — things League does not show you.
  cannon: '◆',
  back: '⌂',
  jungle: '🌿',
  roam: '➜',
  spike: '⚡',
  pace: '📉',
  // Mirrored — things the game's own HUD shows. Muted on the overlay by
  // default; still available in the companion window.
  wave: '▪',
  scuttle: '🦀',
  dragon: '🐉',
  herald: '👁',
  grubs: '🪱',
  baron: '👑',
  // User-driven.
  manual: '⏱',
  reminder: '!',
};

export function cueGlyph(kind: CueKind): string {
  return KIND_GLYPHS[kind] ?? '•';
}
