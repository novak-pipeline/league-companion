import { useState } from 'react';
import type { CSSProperties, ReactElement } from 'react';

import { portraitUrl } from '../../core/draft/champions.js';

/**
 * A champion square, backed by Riot's Data Dragon CDN.
 *
 * The app has to look finished with the network switched off, so this component
 * never depends on the image arriving. When there is no patch version yet, or
 * the request fails, it draws a deterministic initial tile instead — same
 * champion, same colour, every launch — rather than a broken-image glyph.
 *
 * Data Dragon is the only remote host the CSP allows (`img-src`); do not point
 * this at any other CDN, the request will simply be blocked.
 */

export interface ChampionPortraitProps {
  /** Data Dragon champion id, e.g. "Ahri", "MonkeyKing". */
  championId: string;
  /** Display name, used for the alt text and tooltip. */
  name?: string;
  /** Data Dragon patch, from `state.dataStatus.ddragon.patch`. Null when unknown. */
  version: string | null;
  /** Edge length in px. */
  size?: number;
  /** Circular instead of the default rounded square. */
  rounded?: boolean;
  /** Extra classes, e.g. to dim a banned or dead champion. */
  className?: string;
}

/**
 * Stable hue per champion id. Any hash would do; this one is short, has no
 * dependencies and — importantly — is deterministic across sessions, so a
 * champion's fallback tile is always the same colour the user learned last time.
 */
function hueFor(championId: string): number {
  let hash = 0;
  for (let index = 0; index < championId.length; index += 1) {
    hash = (hash * 31 + championId.charCodeAt(index)) % 360_000;
  }
  return hash % 360;
}

function initialsFor(label: string): string {
  const trimmed = label.trim();
  if (trimmed.length === 0) return '?';
  return trimmed.slice(0, 2).toUpperCase();
}

export function ChampionPortrait({
  championId,
  name,
  version,
  size = 40,
  rounded = false,
  className,
}: ChampionPortraitProps): ReactElement {
  // Remembering *which* src failed rather than a bare boolean means a patch
  // bump or a champion swap retries by itself, with no effect and no key prop.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);

  const label = name ?? championId;
  const src = version ? portraitUrl(championId, version) : null;

  const geometry: CSSProperties = {
    width: size,
    height: size,
    minWidth: size,
    borderRadius: rounded ? '50%' : Math.max(4, Math.round(size * 0.16)),
  };

  const classes = className ? `champ-portrait ${className}` : 'champ-portrait';
  const hue = hueFor(championId);
  const showImage = src !== null && failedSrc !== src;

  // The initials tile is always rendered, with the image layered over it. An
  // either/or would leave the tile blank for as long as the request is in
  // flight — which on a cold cache or a slow connection is long enough to look
  // broken, and never resolves at all if the CDN is unreachable but does not
  // fail fast. This way the fallback simply shows through until art arrives.
  return (
    <span
      className={`${classes} champ-portrait--fallback`}
      role="img"
      aria-label={label}
      title={label}
      style={{
        ...geometry,
        position: 'relative',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
        background: `hsl(${hue} 36% 19%)`,
        borderColor: `hsl(${hue} 32% 31%)`,
        color: `hsl(${hue} 68% 74%)`,
        fontSize: Math.max(9, Math.round(size * 0.34)),
      }}
    >
      {initialsFor(label)}
      {showImage ? (
        <img
          src={src}
          alt=""
          width={size}
          height={size}
          draggable={false}
          onError={() => setFailedSrc(src)}
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            borderRadius: 'inherit',
          }}
        />
      ) : null}
    </span>
  );
}
