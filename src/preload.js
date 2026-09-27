const { contextBridge, ipcRenderer } = require('electron');

// Android's cp1 Java object exposes these three methods directly and
// synchronously. Keeping the values in the preload removes a renderer->main
// IPC round trip from the earliest boot code and matches WebView semantics.
const CAPABILITIES = JSON.stringify({
  bank: true,
  'ui:bifocal-webview': true,
  'ui:auth-webview': true,
  'network:info': true,
  'debug:diagnostics-option': false,
  'debug:download-queue': false,
  'diagnostics:log': true,
  'audio:autonomous': true,
  geolocation: true,
  'ui:haptics': true,
  'feedback:store': null,
  'email:compose': true,
  'platform:traits': true,
  'audio:sleep-at-position': true,
  'audio:milestones': true,
  'ui:dictionary': true,
  'ui:oauth': 'dewey-oauth',
  'notifier:schedule': true,
  'notifier:badge': false,
  'notifier:list': null,
  'nav:share': ['url', 'text', 'image', 'file'],
  'notifier:receive': true,
  'ui:passkey': true,
  'audio:speech-synthesis': { supported: true, resumable: false },
  'dervish:activity': { pending: true },
  'platform:referrer': ['install', 'session'],
  'diagnostics:platform-settings': ['app', 'app-geolocation-permissions', 'app-notifications', 'network', 'app-language']
});
const ENVIRONMENT = 'charlie';

contextBridge.exposeInMainWorld('LIBBY_WINDOWS', Object.freeze({
  retry: () => ipcRenderer.send('recovery-retry'),
  diagnostics: () => ipcRenderer.send('recovery-diagnostics')
}));

contextBridge.exposeInMainWorld('BRIDGE', Object.freeze({
  capabilities: () => CAPABILITIES,
  environment: () => ENVIRONMENT,
  clientToShellAsJSON: (json) => ipcRenderer.send('bridge-shell-message', json)
}));

// The Android shell dispatches exactly this DOM event. Keep a tiny queue so a
// native startup signal cannot be lost if it arrives during document startup.
const pending = [];
let bridgeListenersReady = false;
function deliver(payload) {
  const event = new CustomEvent('bridge:receive', { detail: payload });
  window.dispatchEvent(event);
}
ipcRenderer.on('libby-shell-event', (_event, payload) => {
  if (!bridgeListenersReady && document.readyState === 'loading') pending.push(payload);
  else deliver(payload);
});
ipcRenderer.on('libby-media-key', (_event, key) => {
  window.dispatchEvent(new CustomEvent('libby:media-key', { detail: { key } }));
});
window.addEventListener('DOMContentLoaded', () => {
  bridgeListenersReady = true;
  while (pending.length) deliver(pending.shift());
});

window.addEventListener('error', (event) => {
  ipcRenderer.send('renderer-diagnostic', {
    type: 'error', message: event.message || String(event.error || 'renderer error'),
    source: event.filename || '', line: event.lineno || 0, column: event.colno || 0
  });
});
window.addEventListener('unhandledrejection', (event) => {
  ipcRenderer.send('renderer-diagnostic', {
    type: 'unhandledrejection', message: String(event.reason && (event.reason.stack || event.reason.message) || event.reason || '')
  });
});
