const { contextBridge, ipcRenderer } = require('electron');

// Android's addJavascriptInterface exposes synchronous Java methods.
// Use sendSync here; using ipcRenderer.invoke() changes the return value into
// a Promise and is not equivalent to the Android bridge.
contextBridge.exposeInMainWorld('BRIDGE', {
  capabilities: () => ipcRenderer.sendSync('bridge-capabilities-sync'),
  environment: () => ipcRenderer.sendSync('bridge-environment-sync'),
  clientToShellAsJSON: (json) => {
    ipcRenderer.send('bridge-shell-message', json);
  }
});

// Keep native->web events on the DOM. The Android client uses:
// window.dispatchEvent(new CustomEvent("bridge:receive", {detail: payload}))
ipcRenderer.on('libby-shell-event', (_event, payload) => {
  window.dispatchEvent(new CustomEvent('bridge:receive', { detail: payload }));
});

ipcRenderer.on('libby-media-key', (_event, key) => {
  window.dispatchEvent(new CustomEvent('libby:media-key', { detail: { key } }));
});
