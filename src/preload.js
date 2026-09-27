const { contextBridge, ipcRenderer } = require('electron');

const CAPABILITIES = JSON.stringify({
  "bank": true,
  "ui:bifocal-webview": true,
  "ui:auth-webview": true,
  "network:info": true,
  "debug:diagnostics-option": false,
  "debug:download-queue": false,
  "diagnostics:log": true,
  "audio:autonomous": true,
  "geolocation": true,
  "ui:haptics": true,
  "feedback:store": null,
  "email:compose": true,
  "platform:traits": true,
  "audio:sleep-at-position": true,
  "audio:milestones": true,
  "ui:dictionary": true,
  "ui:oauth": "dewey-oauth",
  "notifier:schedule": true,
  "notifier:badge": false,
  "notifier:list": null,
  "nav:share": ["url", "text", "image", "file"],
  "notifier:receive": true,
  "ui:passkey": true,
  "diagnostics:platform-settings": ["app", "app-geolocation-permissions", "app-notifications", "network", "app-language"],
  "audio:speech-synthesis": {"supported": true, "resumable": false},
  "dervish:activity": {"pending": true},
  "platform:referrer": ["install", "session"]
});

const ENVIRONMENT = 'charlie';

// Android's @JavascriptInterface methods are synchronous. Do not return a Promise here.
contextBridge.exposeInMainWorld('BRIDGE', {
  capabilities: () => CAPABILITIES,
  environment: () => ENVIRONMENT,
  clientToShellAsJSON: (json) => {
    try { ipcRenderer.send('bridge-shell-message-sync', json); } catch {}
  }
});

// Android delivers native-to-web bridge messages as DOM CustomEvents named bridge:receive.
// Nothing is posted through window.postMessage, because Libby listens for the Android event.
ipcRenderer.on('libby-media-key', (_event, key) => {
  try {
    window.postMessage({ source: 'libby-windows-port', type: 'media-key', key }, '*');
  } catch {}
});
