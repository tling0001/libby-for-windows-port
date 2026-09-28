const { contextBridge, ipcRenderer } = require('electron');

// Compatibility bridge matching the Android shell's three JavaScript-visible methods.
contextBridge.exposeInMainWorld('BRIDGE', {
  capabilities: () => ipcRenderer.invoke('bridge-capabilities'),
  environment: () => ipcRenderer.invoke('bridge-environment'),
  clientToShellAsJSON: (json) => ipcRenderer.invoke('bridge-shell-message', json)
});

// Small compatibility surface for native events the web client can listen for.
window.addEventListener('DOMContentLoaded', () => {
  window.postMessage({ source: 'libby-windows-port', type: 'platform-ready' }, '*');
});

ipcRenderer.on('libby-shell-event', (_event, payload) => {
  window.postMessage({ source: 'libby-windows-port', type: 'shell-event', payload }, '*');
});

ipcRenderer.on('libby-media-key', (_event, key) => {
  window.postMessage({ source: 'libby-windows-port', type: 'media-key', key }, '*');
});
