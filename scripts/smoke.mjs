/**
 * Headless smoke test.
 *
 * Boots the real application entry point — not a reconstruction of it — and
 * asserts the things unit tests structurally cannot: that Electron loads the
 * preload bridge, that both renderer bundles mount without throwing, and that
 * the main process answers IPC.
 *
 * This exists because the preload/ESM mismatch that broke every window passed a
 * clean typecheck and a green test suite. Only booting the app caught it.
 *
 * Run: xvfb-run -a electron scripts/smoke.mjs --no-sandbox
 * Exits non-zero on failure so CI fails loudly.
 *
 * NOTE: no top-level `await` on app lifecycle here. With an ESM entry point,
 * Electron finishes evaluating the main module before emitting 'ready', so
 * `await app.whenReady()` at the top level deadlocks the process silently.
 * Everything async lives inside the whenReady callback.
 */
import { app, BrowserWindow } from 'electron';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolate from any real install: a smoke run must never touch user settings.
app.setPath('userData', mkdtempSync(join(tmpdir(), 'lc-smoke-')));

// Static import starts the real app; it registers its own whenReady handler.
import '../dist/main/main/index.js';

const failures = [];
const rendererErrors = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(200);
  }
  failures.push(`timed out waiting for ${label}`);
  return false;
}

/** Console output that is environmental noise rather than an app defect. */
function isIgnorableConsole(message) {
  return (
    message.includes('Content-Security-Policy') ||
    message.includes('Autofill') ||
    message.includes('devtools') ||
    message.includes('xcb_connect') ||
    message.includes('ANGLE')
  );
}

async function run() {
  await waitFor(() => BrowserWindow.getAllWindows().length > 0, 20000, 'windows to open');

  const windows = BrowserWindow.getAllWindows();
  console.log(`smoke: ${windows.length} window(s) opened`);
  if (windows.length === 0) return;

  for (const win of windows) {
    win.webContents.on('console-message', (_e, level, message) => {
      if (level >= 2 && !isIgnorableConsole(message)) {
        rendererErrors.push(message.split('\n')[0]);
      }
    });
    win.webContents.on('did-fail-load', (_e, code, desc) => {
      failures.push(`did-fail-load ${code}: ${desc}`);
    });
  }

  await Promise.all(
    windows.map((w) =>
      w.webContents.isLoading()
        ? new Promise((r) => w.webContents.once('did-finish-load', r))
        : Promise.resolve(),
    ),
  );

  // Give the renderers a beat to mount and take their first state push.
  await sleep(2500);

  for (const win of windows) {
    const kind = await win.webContents.executeJavaScript(`window.companion?.windowKind ?? null`);

    const bridge = await win.webContents.executeJavaScript(
      `typeof window.companion === 'object' && typeof window.companion.send === 'function'`,
    );
    if (!bridge) {
      failures.push(`${kind ?? 'window'}: preload bridge missing on window.companion`);
      continue;
    }
    if (kind !== 'overlay' && kind !== 'companion') {
      failures.push(`windowKind not resolved (got ${JSON.stringify(kind)})`);
    }

    // The overlay legitimately renders nothing with no game running, so only
    // the companion window is required to have painted.
    if (kind === 'companion') {
      const mounted = await win.webContents.executeJavaScript(
        `document.getElementById('root')?.childElementCount ?? 0`,
      );
      if (mounted < 1) failures.push('companion: React root is empty');
    }

    // Round-trip a command to prove main-process IPC is actually wired up.
    const ipcOk = await win.webContents.executeJavaScript(
      `window.companion.send('app:requestState').then(() => true).catch((e) => String(e))`,
    );
    if (ipcOk !== true) failures.push(`${kind}: IPC round-trip failed: ${ipcOk}`);

    console.log(`smoke: ${kind} — bridge ok, mounted ok, ipc ok`);
  }

  for (const message of rendererErrors) failures.push(`renderer error: ${message}`);
}

app.whenReady().then(async () => {
  try {
    await run();
  } catch (error) {
    failures.push(`threw: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (failures.length > 0) {
    console.error(`\nsmoke FAILED (${failures.length}):`);
    for (const f of failures) console.error(`  - ${f}`);
    app.exit(1);
  } else {
    console.log('\nsmoke PASSED');
    app.exit(0);
  }
});
