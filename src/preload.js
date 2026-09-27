const { contextBridge, ipcRenderer } = require('electron');

// The Android app exposes a synchronous JavaScript interface.  Libby's client
// calls these during boot, so these MUST return strings synchronously.
contextBridge.exposeInMainWorld('BRIDGE', {
  capabilities: () => ipcRenderer.sendSync('bridge-capabilities-sync'),
  environment: () => ipcRenderer.sendSync('bridge-environment-sync'),
  clientToShellAsJSON: (json) => ipcRenderer.send('bridge-shell-message', json)
});

// Native -> web messages in the Android shell are literally dispatched into
// the page as CustomEvent("bridge:receive", {detail: ...}).
ipcRenderer.on('libby-shell-event', (_event, payload) => {
  window.dispatchEvent(new CustomEvent('bridge:receive', { detail: payload }));
});

ipcRenderer.on('libby-media-key', (_event, key) => {
  window.dispatchEvent(new CustomEvent('libby:media-key', { detail: { key } }));
});

// Keep diagnostics available without exposing Node/Electron to the remote page.
window.addEventListener('error', (event) => {
  ipcRenderer.send('renderer-diagnostic', {
    type: 'error',
    message: event.message || String(event.error || 'renderer error'),
    source: event.filename || '',
    line: event.lineno || 0,
    column: event.colno || 0
  });
});
window.addEventListener('unhandledrejection', (event) => {
  ipcRenderer.send('renderer-diagnostic', {
    type: 'unhandledrejection',
    message: String(event.reason && (event.reason.stack || event.reason.message) || event.reason || '')
  });
});
