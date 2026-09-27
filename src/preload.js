const { contextBridge, ipcRenderer } = require('electron');

// Android uses WebView.addJavascriptInterface(..., "BRIDGE").  We reproduce
// the synchronous API through Electron's contextBridge: primitive return values
// stay synchronous, while commands are fire-and-forget IPC messages.
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
  'notifier:list': true,
  'nav:share': ['url', 'text', 'image', 'file'],
  'notifier:receive': true,
  'ui:passkey': true,
  'audio:speech-synthesis': { supported: true, resumable: false },
  'dervish:activity': { pending: true },
  'platform:referrer': ['install', 'session'],
  'diagnostics:platform-settings': ['app', 'app-geolocation-permissions', 'app-notifications', 'network', 'app-language']
});
const ENVIRONMENT = 'charlie';

contextBridge.exposeInMainWorld('BRIDGE', {
  capabilities: () => CAPABILITIES,
  environment: () => ENVIRONMENT,
  clientToShellAsJSON: (json) => ipcRenderer.send('bridge-shell-message', json)
});

// Native -> web messages must be dispatched in the MAIN world, because that is
// where Libby's application code and its CustomEvent listener live. Using the
// isolated preload world's window.dispatchEvent is not equivalent when
// contextIsolation is enabled.
function dispatchInMainWorld(payload) {
  contextBridge.executeInMainWorld({
    func: (value) => {
      window.dispatchEvent(new CustomEvent('bridge:receive', { detail: value }));
    },
    args: [payload]
  }).catch(() => {});
}

ipcRenderer.on('libby-shell-event', (_event, payload) => dispatchInMainWorld(payload));
ipcRenderer.on('libby-media-key', (_event, key) => {
  contextBridge.executeInMainWorld({
    func: (value) => window.dispatchEvent(new CustomEvent('libby:media-key', { detail: { key: value } })),
    args: [key]
  }).catch(() => {});
});

ipcRenderer.on('libby-diagnostic', (_event, payload) => {
  try { ipcRenderer.send('renderer-diagnostic', payload); } catch {}
});

window.addEventListener('error', (event) => {
  try {
    ipcRenderer.send('renderer-diagnostic', {
      type: 'error', message: event.message || String(event.error || 'renderer error'),
      source: event.filename || '', line: event.lineno || 0, column: event.colno || 0
    });
  } catch {}
});
window.addEventListener('unhandledrejection', (event) => {
  try {
    ipcRenderer.send('renderer-diagnostic', {
      type: 'unhandledrejection', message: String(event.reason && (event.reason.stack || event.reason.message) || event.reason || '')
    });
  } catch {}
});
