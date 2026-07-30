import { contextBridge, ipcRenderer } from 'electron';

/**
 * Preload bridge.
 *
 * The renderers get exactly two capabilities: subscribe to state, and send a
 * named command. No Node APIs, no ipcRenderer, no filesystem — context
 * isolation stays on and this is the entire surface.
 *
 * This file deliberately imports nothing from the rest of the app. It is
 * compiled separately to CommonJS (Electron loads preloads via require()), and
 * a cross-tree type import would drag the whole source graph into that build.
 * The typed view of this bridge is `CompanionBridge` in `src/shared/ipc.ts`,
 * which the renderers assert against — keep the two in sync by hand.
 */

const IPC_STATE = 'companion:state';
const IPC_COMMAND = 'companion:command';

/** Electron passes `--window-kind=overlay|companion` from the window options. */
function detectWindowKind(): 'overlay' | 'companion' {
  const arg = process.argv.find((a) => a.startsWith('--window-kind='));
  return arg?.split('=')[1] === 'overlay' ? 'overlay' : 'companion';
}

contextBridge.exposeInMainWorld('companion', {
  onState(handler: (state: unknown) => void): () => void {
    const listener = (_event: unknown, state: unknown) => handler(state);
    ipcRenderer.on(IPC_STATE, listener);
    // Ask for the current state immediately so a late-loading window is not
    // blank until the next push.
    void ipcRenderer.invoke(IPC_COMMAND, 'app:requestState', []);
    return () => {
      ipcRenderer.removeListener(IPC_STATE, listener);
    };
  },

  send(name: string, ...args: unknown[]): Promise<unknown> {
    return ipcRenderer.invoke(IPC_COMMAND, name, args);
  },

  windowKind: detectWindowKind(),
});
