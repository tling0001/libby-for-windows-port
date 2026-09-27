const { contextBridge, ipcRenderer } = require('electron');

// Libby's Android shell exposes a synchronous JavaScript bridge named BRIDGE.
// Keep the same API shape on Windows: capabilities() and environment() return
// strings immediately, while clientToShellAsJSON() is fire-and-forget.
contextBridge.exposeInMainWorld('BRIDGE', {
  capabilities: () => ipcRenderer.sendSync('bridge-capabilities-sync'),
  environment: () => ipcRenderer.sendSync('bridge-environment-sync'),
  clientToShellAsJSON: (json) => ipcRenderer.send('bridge-shell-message', json)
});

// The Android shell delivers native -> web messages as a CustomEvent named
// exactly "bridge:receive". Libby listens for this event, so do not substitute
// window.postMessage here.
ipcRenderer.on('libby-shell-event', (_event, payload) => {
  window.dispatchEvent(new CustomEvent('bridge:receive', { detail: payload }));
});

ipcRenderer.on('libby-media-key', (_event, key) => {
  window.dispatchEvent(new CustomEvent('libby:media-key', { detail: { key } }));
});
