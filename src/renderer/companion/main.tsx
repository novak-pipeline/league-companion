import React from 'react';
import { createRoot } from 'react-dom/client';

import type { CompanionBridge } from '../../shared/ipc.js';
import { App } from './App';

/**
 * Companion window entry point.
 *
 * The preload bridge is the only channel to the main process; everything this
 * window renders arrives through `onState`, and every mutation leaves through
 * `send`. There is no direct I/O here.
 */
declare global {
  interface Window {
    companion: CompanionBridge;
  }
}

const container = document.getElementById('root');
if (!container) {
  throw new Error('companion: #root element is missing from companion.html');
}

createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
