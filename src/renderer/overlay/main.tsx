import React from 'react';
import { createRoot } from 'react-dom/client';
import type { CompanionBridge } from '../../shared/ipc.js';
import { Overlay } from './Overlay.js';

/**
 * Overlay entry point.
 *
 * The transparent, click-through window that sits on top of the game. It owns
 * no state of its own beyond countdown interpolation — everything it draws
 * arrives over `window.companion.onState`.
 */

declare global {
  interface Window {
    companion: CompanionBridge;
  }
}

const container = document.getElementById('root');

if (!container) {
  throw new Error('overlay: #root container is missing from overlay.html');
}

createRoot(container).render(
  <React.StrictMode>
    <Overlay />
  </React.StrictMode>,
);
