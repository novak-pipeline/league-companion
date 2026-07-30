import { BrowserWindow, screen, shell } from 'electron';
import { join } from 'node:path';

/**
 * Window construction.
 *
 * The overlay is a transparent, click-through, always-on-top window that draws
 * over the game. It does not touch the League process in any way — it is an
 * ordinary OS window that happens to sit above another one, which is what keeps
 * this approach compatible with Vanguard.
 *
 * Note for users: transparent overlays cannot draw over a game running in
 * exclusive fullscreen. League must be in Borderless or Windowed mode.
 */

const isDev = process.env.LC_DEV === '1';
const DEV_SERVER = 'http://localhost:5173';

function resolveRendererUrl(page: 'overlay' | 'companion'): string {
  if (isDev) return `${DEV_SERVER}/${page}.html`;
  // Packaged: dist/main/main/windows.js -> ../../renderer/<page>.html
  return `file://${join(import.meta.dirname, '../../renderer', `${page}.html`)}`;
}

function preloadPath(): string {
  // dist/main/main/windows.js -> dist/main/preload/index.cjs
  // The .cjs extension is required: Electron loads preload scripts with
  // require(), and this package is "type": "module", so a .js file here would
  // be treated as ESM and fail with ERR_REQUIRE_ESM.
  return join(import.meta.dirname, '../preload/index.cjs');
}

export function createOverlayWindow(): BrowserWindow {
  const primary = screen.getPrimaryDisplay();
  const { width, height } = primary.workAreaSize;

  const win = new BrowserWindow({
    width,
    height,
    x: primary.workArea.x,
    y: primary.workArea.y,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    hasShadow: false,
    // Never steal focus from the game.
    focusable: false,
    alwaysOnTop: true,
    // Shown once the renderer has painted, to avoid a white flash.
    show: false,
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      additionalArguments: ['--window-kind=overlay'],
    },
  });

  // 'screen-saver' is the highest level that still works over fullscreen apps.
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // Clicks pass straight through to the game; `forward` keeps mouse-move events
  // flowing so hover effects still work if interactivity is switched on later.
  win.setIgnoreMouseEvents(true, { forward: true });

  void win.loadURL(resolveRendererUrl('overlay'));
  win.once('ready-to-show', () => win.showInactive());

  return win;
}

export function createCompanionWindow(): BrowserWindow {
  const displays = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();
  // Prefer a second monitor when one exists — that is where this window lives.
  const target = displays.find((d) => d.id !== primary.id) ?? primary;

  const win = new BrowserWindow({
    width: Math.min(1400, target.workAreaSize.width - 80),
    height: Math.min(900, target.workAreaSize.height - 80),
    x: target.workArea.x + 40,
    y: target.workArea.y + 40,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0f1216',
    title: 'League Companion',
    show: false,
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      additionalArguments: ['--window-kind=companion'],
    },
  });

  void win.loadURL(resolveRendererUrl('companion'));
  win.once('ready-to-show', () => win.show());

  // External links open in the real browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  return win;
}

/** Toggles whether the overlay accepts clicks. */
export function setOverlayInteractive(win: BrowserWindow, interactive: boolean): void {
  win.setIgnoreMouseEvents(!interactive, { forward: true });
}
