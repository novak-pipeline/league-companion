import type { CueKind } from '../../core/types.js';

/**
 * One glyph per cue kind, shared by the overlay and the companion window so a
 * symbol means the same thing on both screens. Unicode only — nothing to load,
 * and it survives the overlay's `img-src`-restricted CSP.
 */
const KIND_GLYPHS: Record<CueKind, string> = {
  cannon: '◆',
  wave: '▪',
  scuttle: '🦀',
  dragon: '🐉',
  herald: '👁',
  grubs: '🪱',
  baron: '👑',
  atakhan: '⚔',
  back: '⌂',
  manual: '⏱',
  reminder: '!',
};

export function cueGlyph(kind: CueKind): string {
  return KIND_GLYPHS[kind] ?? '•';
}
