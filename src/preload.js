const { ipcRenderer } = require('electron');

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

// Use the same shape as Android's injected Java object: a real object in the
// page's main JS world with synchronous methods, not an asynchronous Promise
// proxy. Electron still has no Node integration, so exposing these two values
// is safe while shell messages go through the isolated IPC boundary.

try {
  Object.defineProperty(Navigator.prototype, 'platform', { configurable: true, get: () => 'Win32' });
  Object.defineProperty(Navigator.prototype, 'vendor', { configurable: true, get: () => 'Google Inc.' });
  Object.defineProperty(Navigator.prototype, 'maxTouchPoints', { configurable: true, get: () => 0 });
  // Electron exposes Chromium UA Client Hints that can reveal the host even when
  // navigator.userAgent is overridden. Present ordinary Chrome/Windows hints.
  const chromeMajor = Number(String(process.versions.chrome || '140').split('.')[0]);
  const uaData = {
    brands: [
      { brand: 'Chromium', version: String(chromeMajor) },
      { brand: 'Google Chrome', version: String(chromeMajor) }
    ],
    mobile: false,
    platform: 'Windows',
    getHighEntropyValues: async () => ({
      brands: [
        { brand: 'Chromium', version: String(chromeMajor) },
        { brand: 'Google Chrome', version: String(chromeMajor) }
      ],
      mobile: false, platform: 'Windows', platformVersion: '10.0.0',
      architecture: 'x86', bitness: '64', model: '', uaFullVersion: String(process.versions.chrome || '')
    })
  };
  Object.defineProperty(Navigator.prototype, 'userAgentData', { configurable: true, get: () => uaData });
} catch {}

window.BRIDGE = {
  capabilities: function() { return CAPABILITIES; },
  environment: function() { return ENVIRONMENT; },
  clientToShellAsJSON: function(json) { ipcRenderer.send('bridge-shell-message', json); }
};

window.LIBBY_WINDOWS = Object.freeze({
  retry: () => ipcRenderer.send('recovery-retry'),
  diagnostics: () => ipcRenderer.send('recovery-diagnostics')
});

const pending = [];
let bridgeListenersReady = false;
function deliver(payload) {
  window.dispatchEvent(new CustomEvent('bridge:receive', { detail: payload }));
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
