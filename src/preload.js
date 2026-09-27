const { ipcRenderer } = require('electron');

// The Android shell exposes a real synchronous JavaScript interface.
// Do NOT use contextBridge.invoke() here: that returns a Promise and is
// observably different from Android's @JavascriptInterface methods.
const ANDROID_CAPABILITIES = JSON.stringify({
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
  'nav:share': ['url', 'text', 'image', 'file']
});

const ANDROID_ENVIRONMENT = 'charlie';

// contextIsolation is deliberately disabled in main.js so this object lives
// in the page's main world, just like addJavascriptInterface('BRIDGE').
window.BRIDGE = {
  capabilities() {
    return ANDROID_CAPABILITIES;
  },
  environment() {
    return ANDROID_ENVIRONMENT;
  },
  clientToShellAsJSON(json) {
    // Android's method returns void. ipcRenderer.send() is fire-and-forget
    // and therefore also returns undefined synchronously.
    ipcRenderer.send('bridge-shell-message', json);
  }
};

// Android sends native -> web messages as:
// window.dispatchEvent(new CustomEvent('bridge:receive', { detail: {...} }))
// Reproduce that exact observable contract rather than postMessage().
ipcRenderer.on('libby-bridge-receive', (_event, payload) => {
  try {
    window.dispatchEvent(new CustomEvent('bridge:receive', { detail: payload }));
  } catch (_) {}
});

ipcRenderer.on('libby-media-key', (_event, key) => {
  try {
    window.dispatchEvent(new CustomEvent('bridge:receive', {
      detail: { name: 'media:key', dest: 'client', key }
    }));
  } catch (_) {}
});
