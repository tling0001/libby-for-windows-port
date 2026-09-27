const { ipcRenderer } = require('electron');

// Android WebView's addJavascriptInterface() places BRIDGE directly in the
// page's JavaScript world. Use contextIsolation:false so Libby's bootstrap sees
// the same kind of plain synchronous object rather than an Electron proxy.
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

// Match the Android WebView-facing navigator values in the same world as the
// Libby application. The actual HTTP UA is controlled by the Electron session.
try {
  const LIBBY_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 (Dewey; V32; Android; 9.5.0; RELEASE)';
  Object.defineProperty(Navigator.prototype, 'userAgent', { configurable: true, get: () => LIBBY_UA });
  Object.defineProperty(Navigator.prototype, 'platform', { configurable: true, get: () => 'Linux armv8l' });
  Object.defineProperty(Navigator.prototype, 'vendor', { configurable: true, get: () => 'Google Inc.' });
  Object.defineProperty(Navigator.prototype, 'maxTouchPoints', { configurable: true, get: () => 5 });
  Object.defineProperty(Navigator.prototype, 'webdriver', { configurable: true, get: () => false });
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
} catch {}

// Keep this synchronous, exactly like the Android @JavascriptInterface methods.
window.BRIDGE = {
  capabilities: function () { return CAPABILITIES; },
  environment: function () { return ENVIRONMENT; },
  clientToShellAsJSON: function (json) { ipcRenderer.send('bridge-shell-message', json); }
};

// Android's bridge_receive resource is literally "bridge:receive" and its
// bm.a() implementation dispatches a CustomEvent in the page's main world.
const pending = [];
let pageReady = false;
function deliver(payload) {
  const event = new CustomEvent('bridge:receive', { detail: payload });
  window.dispatchEvent(event);
}
ipcRenderer.on('libby-shell-event', (_event, payload) => {
  if (!pageReady && document.readyState === 'loading') pending.push(payload);
  else deliver(payload);
});
ipcRenderer.on('libby-media-key', (_event, key) => {
  window.dispatchEvent(new CustomEvent('libby:media-key', { detail: { key } }));
});
window.addEventListener('DOMContentLoaded', () => {
  pageReady = true;
  while (pending.length) deliver(pending.shift());
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
