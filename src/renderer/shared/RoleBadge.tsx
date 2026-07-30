import type { ReactElement } from 'react';

import type { Role } from '../../core/types.js';

/**
 * Role pill.
 *
 * Deliberately typographic: no image assets to ship, nothing to load, and it
 * still reads at 10px. Each role gets its own hue so a comp's shape is legible
 * from the colours alone once the abbreviations become familiar.
 */

const ROLE_SHORT: Record<Role, string> = {
  top: 'TOP',
  jungle: 'JNG',
  mid: 'MID',
  adc: 'BOT',
  support: 'SUP',
};

const ROLE_FULL: Record<Role, string> = {
  top: 'Top lane',
  jungle: 'Jungle',
  mid: 'Mid lane',
  adc: 'Bot lane / ADC',
  support: 'Support',
};

export interface RoleBadgeProps {
  role: Role;
  /** Renders a muted variant, for rows that are not the focus. */
  muted?: boolean;
}

export function RoleBadge({ role, muted = false }: RoleBadgeProps): ReactElement {
  return (
    <span
      className={`role-badge role-${role}${muted ? ' is-muted' : ''}`}
      title={ROLE_FULL[role]}
    >
      {ROLE_SHORT[role]}
    </span>
  );
}

/** Placeholder that keeps a column aligned when the role is unknown. */
export function RoleBadgeSlot({ role }: { role: Role | undefined }): ReactElement {
  if (!role) return <span className="role-badge role-unknown" title="Role not reported" aria-hidden="true">—</span>;
  return <RoleBadge role={role} />;
}
