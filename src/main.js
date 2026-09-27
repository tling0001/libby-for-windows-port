const {
  app, BrowserWindow, BrowserView, session, shell, ipcMain, dialog,
  Notification, nativeTheme, globalShortcut, Menu, clipboard
} = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT_URL = 'https://libbyapp.com';
const APP_VERSION = '9.5.0';
const PRODUCT = 'Dewey';
const SPEC = 'V32';
const ENVIRONMENT = 'charlie';

// Requested Libby native-shell UA.
// Keep the Chrome version explicit so it is stable across Electron updates.
const APP_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/140.0.0.0 Safari/537.36 ' +
  `(Dewey; V32; Android; ${APP_VERSION}; RELEASE)`;

let mainWindow = null;
let splashWindow = null;
let splashClosed = false;
let shellState = { lastNavigation: ROOT_URL };
const pendingNativeEvents = [];

function dataDir() {
  const p = path.join(app.getPath('userData'), 'libby');
  fs.mkdirSync(p, { recursive: true });
  return p;
}
function downloadsDir() {
  const p = path.join(app.getPath('downloads'), 'Libby');
  fs.mkdirSync(p, { recursive: true });
  return p;
}

function androidCapabilities() {
  // Base capabilities copied from the Android 9.5.0 resources.
  // Keep these conservative: do not advertise invented capabilities because
  // the web client uses this object to select its native-shell paths.
  const value = {
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
  };

  // cp1.java adds these at runtime on supported Android versions.
  value['notifier:receive'] = true;
  value['notifier:list'] = true;
  value['diagnostics:platform-settings'] =
    ['app', 'app-geolocation-permissions', 'app-notifications', 'network', 'app-language'];
  value['ui:passkey'] = true;
  value['audio:speech-synthesis'] = { supported: true, resumable: false };
  value['dervish:activity'] = { pending: true };
  value['platform:referrer'] = ['install', 'session'];

  return JSON.stringify(value);
}

function androidEnvironment() {
  return ENVIRONMENT;
}

function platformTraits(dest = 'client') {
  return {
    name: 'platform:traits',
    dest,
    device: {
      brand: 'Microsoft',
      model: 'Windows PC',
      platform: 'Android',
      platformBuild: process.getSystemVersion(),
      platformVersion: process.getSystemVersion(),
      platformVersionInt: 0
    },
    profile: {
      darkTheme: nativeTheme.shouldUseDarkColors,
      highContrast: false,
      storagePath: dataDir(),
      installer: 'windows',
      language: { app: app.getLocale(), system: app.getLocale() }
    }
  };
}

function emitToPage(payload) {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) {
    pendingNativeEvents.push(payload);
    return;
  }
  // Run in the actual page/main world. Android's cp1 sends a DOM CustomEvent
  // named exactly "bridge:receive".
  const encoded = JSON.stringify(payload);
  const script = `
    (() => {
      const detail = ${encoded};
      window.dispatchEvent(new CustomEvent('bridge:receive', { detail }));
    })();
  `;
  mainWindow.webContents.executeJavaScript(script, true).catch(() => {
    pendingNativeEvents.push(payload);
  });
}

function flushNativeEvents() {
  if (!pendingNativeEvents.length) return;
  const events = pendingNativeEvents.splice(0);
  for (const event of events) emitToPage(event);
}

async function sendShellResponse(name, data = {}, dest = 'client') {
  emitToPage({ name, dest, ...data });
}

function safeParse(raw) {
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
}

// Minimal persistent "bank" store. The Android app uses bank:* as a native
// persistence service; keeping it persistent across launches is important.
const bankFile = () => path.join(dataDir(), 'bank.json');
function readBank() {
  try { return JSON.parse(fs.readFileSync(bankFile(), 'utf8')); } catch { return {}; }
}
function writeBank(obj) {
  fs.writeFileSync(bankFile(), JSON.stringify(obj));
}

async function handleBank(name, msg) {
  const store = readBank();
  const data = msg.data && typeof msg.data === 'object' ? msg.data : msg;
  const key = data.key ?? data.name ?? data.id;
  if (name === 'bank:read' || name === 'bank:get') {
    return sendShellResponse('bank:response', { key, value: key == null ? null : store[key] });
  }
  if (name === 'bank:write' || name === 'bank:set' || name === 'bank:put') {
    if (key != null) store[key] = data.value;
    writeBank(store);
    return sendShellResponse('bank:response', { key, value: key == null ? null : store[key] });
  }
  if (name === 'bank:delete' || name === 'bank:remove') {
    if (key != null) delete store[key];
    writeBank(store);
    return sendShellResponse('bank:response', { key, value: null });
  }
  if (name === 'bank:exists') {
    return sendShellResponse('bank:response', { key, exists: key != null && Object.prototype.hasOwnProperty.call(store, key) });
  }
  if (name === 'bank:list') {
    return sendShellResponse('bank:response', { keys: Object.keys(store) });
  }
  if (name === 'bank:wipe' || name === 'bank:wipe:all') {
    writeBank({});
    return sendShellResponse('bank:response', { ok: true });
  }
}

async function handleShellMessage(raw) {
  const msg = safeParse(raw);
  if (!msg || typeof msg !== 'object') return;
  const name = String(msg.name || '');
  const dest = msg.dest || 'client';
  const data = msg.data && typeof msg.data === 'object' ? msg.data : msg;

  if (name.startsWith('bank:')) return handleBank(name, msg);

  if (name === 'platform:traits') {
    return sendShellResponse('platform:traits', platformTraits(dest), dest);
  }

  if (name === 'network:info') {
    return sendShellResponse('network:info', {
      reachable: true,
      metered: false,
      connection: 'ethernet'
    }, dest);
  }

  if (name === 'environment:launch') {
    // Android receives this as a request to relaunch the client WebView.
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.reload();
    }
    return;
  }

  if (name === 'ui:haptics') return;

  if (name === 'email:compose') {
    const to = encodeURIComponent(data.to || '');
    const subject = encodeURIComponent(data.subject || '');
    const body = encodeURIComponent(data.body || '');
    return shell.openExternal(`mailto:${to}?subject=${subject}&body=${body}`).catch(() => {});
  }

  if (name === 'nav:share') {
    const text = data.text || data.url || '';
    if (text) {
      clipboard.writeText(text);
      if (Notification.isSupported()) {
        new Notification({ title: 'Libby', body: 'Link copied to the clipboard.' }).show();
      }
    }
    return;
  }

  if (name === 'notifier:schedule') {
    const title = data.title || 'Libby';
    const body = data.body || data.message || '';
    const delay = Math.max(0, Number(data.delayMs ?? data.delay ?? 0));
    setTimeout(() => {
      if (Notification.isSupported()) new Notification({ title, body }).show();
    }, delay);
    return;
  }

  if (name === 'notifier:cancel') return;
  if (name === 'notifier:list') return sendShellResponse('notifier:list', { notifications: [] });
  if (name === 'title:list:playable') return;

  if (name.startsWith('roster:')) {
    // Keep the request observable and non-blocking. Full roster synchronization
    // is implemented separately; never stall the client waiting for it.
    return sendShellResponse('roster:response', {
      request: msg.request || data.request,
      status: 501,
      headers: {},
      rosters: []
    });
  }

  if (name === 'audioproxy:configure') {
    return sendShellResponse('audioproxy:configure', {
      volume: 1, playbackRate: 1
    }, 'bifocal');
  }

  if (name === 'audio:sleep-at-position' || name === 'audio:milestones') return;
}

function makeSplash() {
  splashClosed = false;
  splashWindow = new BrowserWindow({
    width: 500,
    height: 500,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    closable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    backgroundColor: '#111111',
    icon: path.join(__dirname, '..', 'assets', 'libby.ico'),
    webPreferences: { contextIsolation: true, sandbox: true }
  });

  const icon = `file://${path.join(__dirname, '..', 'assets', 'libby.ico').replace(/\\\\/g, '/')}`;
  splashWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`
    <!doctype html>
    <html><head><style>
      html,body{margin:0;width:100%;height:100%;background:#111111;overflow:hidden}
      body{display:flex;align-items:center;justify-content:center}
      img{width:180px;height:180px;object-fit:contain;opacity:0;animation:show .65s ease-out forwards}
      @keyframes show{from{opacity:0;transform:scale(.94)}to{opacity:1;transform:scale(1)}}
    </style></head><body><img src="${icon}"></body></html>
  `)}`).catch(() => {});
  splashWindow.once('ready-to-show', () => {
    if (splashWindow && !splashWindow.isDestroyed()) splashWindow.show();
  });
  splashWindow.on('closed', () => { splashWindow = null; splashClosed = true; });
}

function closeSplash() {
  if (splashClosed || !splashWindow || splashWindow.isDestroyed()) return;
  splashClosed = true;
  const w = splashWindow;
  splashWindow = null;
  try { w.close(); } catch {}
}

function createWindow() {
  const partition = 'persist:libby';
  const ses = session.fromPartition(partition);

  ses.setUserAgent(APP_USER_AGENT);

  // Android WebView accepts third-party cookies.
  ses.cookies.flushStore().catch(() => {});

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 900,
    minHeight: 650,
    show: false,
    title: 'Libby',
    icon: path.join(__dirname, '..', 'assets', 'libby.ico'),
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      partition,
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
      spellcheck: true,
      webviewTag: false
    }
  });

  // Match the Android WebView's basic settings.
  mainWindow.webContents.setUserAgent(APP_USER_AGENT);

  // Do not impose a host allow-list on Libby's navigation. Android WebView
  // follows HTTPS redirects; blocking an auth/CDN redirect can leave Libby
  // permanently on its loading screen.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) return { action: 'allow' };
    shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });

  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(['geolocation', 'notifications', 'media', 'clipboard-read', 'clipboard-sanitized-write'].includes(permission));
  });
  ses.setPermissionCheckHandler((_wc, permission) => {
    return ['geolocation', 'notifications', 'media', 'clipboard-read', 'clipboard-sanitized-write'].includes(permission);
  });

  ses.on('will-download', (event, item) => {
    const target = path.join(downloadsDir(), item.getFilename());
    item.setSavePath(target);
    item.once('done', (_e, state) => {
      if (state === 'completed' && Notification.isSupported()) {
        new Notification({ title: 'Libby download complete', body: item.getFilename() }).show();
      }
    });
  });

  mainWindow.webContents.on('did-navigate', (_e, url) => { shellState.lastNavigation = url; });
  mainWindow.webContents.on('did-finish-load', () => {
    flushNativeEvents();
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    closeSplash();
  });

  mainWindow.on('closed', () => { mainWindow = null; });

  // IMPORTANT: ip1.loadUrl() calls clearCache(true) on every load.
  // Clear Chromium HTTP cache but retain cookies/local storage/IndexedDB.
  ses.clearCache().catch(() => {}).finally(() => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.loadURL(ROOT_URL);
  });

  try {
    globalShortcut.register('MediaPlayPause', () => mainWindow?.webContents.send('libby-media-key', 'playpause'));
    globalShortcut.register('MediaNextTrack', () => mainWindow?.webContents.send('libby-media-key', 'next'));
    globalShortcut.register('MediaPreviousTrack', () => mainWindow?.webContents.send('libby-media-key', 'previous'));
  } catch {}
}

ipcMain.on('bridge-capabilities-sync', (event) => {
  event.returnValue = androidCapabilities();
});
ipcMain.on('bridge-environment-sync', (event) => {
  event.returnValue = androidEnvironment();
});
ipcMain.on('bridge-shell-message', (_event, raw) => {
  void handleShellMessage(raw);
});
ipcMain.handle('app-paths', () => ({
  userData: app.getPath('userData'),
  downloads: downloadsDir()
}));
ipcMain.handle('open-external', (_event, url) => shell.openExternal(url));

app.whenReady().then(() => {
  app.setAppUserModelId('com.overdrive.mobile.android.libby');
  makeSplash();
  createWindow();

  app.on('activate', () => {
    if (!mainWindow) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('will-quit', () => {
  try { globalShortcut.unregisterAll(); } catch {}
});
