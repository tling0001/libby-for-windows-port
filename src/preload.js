const { contextBridge, ipcRenderer } = require('electron');

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
  Object.defineProperty(Navigator.prototype, 'platform', { configurable: true, get: () => 'Linux armv8l' });
  Object.defineProperty(Navigator.prototype, 'vendor', { configurable: true, get: () => 'Google Inc.' });
  Object.defineProperty(Navigator.prototype, 'maxTouchPoints', { configurable: true, get: () => 5 });
  // Electron exposes Chromium UA Client Hints that can reveal the host even when
  // navigator.userAgent is overridden. Present ordinary Chrome/Windows hints.
  const chromeMajor = 140;
  const uaData = {
    brands: [
      { brand: 'Chromium', version: String(chromeMajor) },
      { brand: 'Google Chrome', version: String(chromeMajor) }
    ],
    mobile: true,
    platform: 'Android',
    getHighEntropyValues: async () => ({
      brands: [
        { brand: 'Chromium', version: String(chromeMajor) },
        { brand: 'Google Chrome', version: String(chromeMajor) }
      ],
      mobile: true, platform: 'Android', platformVersion: '15',
      architecture: 'arm', bitness: '64', model: '', uaFullVersion: String(process.versions.chrome || '')
    })
  };
  Object.defineProperty(Navigator.prototype, 'userAgentData', { configurable: true, get: () => uaData });
  Object.defineProperty(Navigator.prototype, 'webdriver', { configurable: true, get: () => false });
} catch {}

// Android WebView exposes the BRIDGE in the page's main world before Libby's
// scripts execute. Electron's contextBridge exposes the same API there, but
// navigator.userAgentData must also be patched in the main world (the preload
// isolated world cannot alter the page's Navigator prototype).
try {
  if (typeof contextBridge.executeInMainWorld === 'function') {
    contextBridge.executeInMainWorld({
      func: () => {
        try {
          const brands = [
            { brand: 'Chromium', version: '140' },
            { brand: 'Google Chrome', version: '140' }
          ];
          const uaData = {
            brands,
            mobile: true,
            platform: 'Android',
            getHighEntropyValues: async () => ({
              brands,
              mobile: true,
              platform: 'Android',
              platformVersion: '15',
              architecture: 'arm',
              bitness: '64',
              model: '',
              uaFullVersion: '140.0.0.0'
            })
          };
          Object.defineProperty(Navigator.prototype, 'userAgentData', { configurable: true, get: () => uaData });
          Object.defineProperty(Navigator.prototype, 'platform', { configurable: true, get: () => 'Linux armv8l' });
          Object.defineProperty(Navigator.prototype, 'vendor', { configurable: true, get: () => 'Google Inc.' });
          Object.defineProperty(Navigator.prototype, 'maxTouchPoints', { configurable: true, get: () => 5 });
          Object.defineProperty(Navigator.prototype, 'webdriver', { configurable: true, get: () => false });
        } catch {}
      }
    });
  }
} catch {}

contextBridge.exposeInMainWorld('BRIDGE', {
  // These MUST remain synchronous. Android's WebView JavascriptInterface
  // methods return strings directly, and Libby calls them during bootstrap.
  capabilities: function() { return ipcRenderer.sendSync('bridge-capabilities-sync'); },
  environment: function() { return ipcRenderer.sendSync('bridge-environment-sync'); },
  clientToShellAsJSON: function(json) { ipcRenderer.send('bridge-shell-message', json); }
});

contextBridge.exposeInMainWorld('LIBBY_WINDOWS', Object.freeze({
  retry: () => ipcRenderer.send('recovery-retry'),
  diagnostics: () => ipcRenderer.send('recovery-diagnostics')
}));

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
