const {
  app,
  BrowserWindow,
  session,
  shell,
  ipcMain,
  dialog,
  Notification,
  nativeTheme,
  globalShortcut,
  Menu,
  clipboard
} = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT_URL = 'https://libbyapp.com';
const APP_VERSION = '9.5.0';
const PRODUCT = 'Dewey';
const SPEC = 'V32';
const ENVIRONMENT = 'charlie';
const APP_CHROME_VERSION = '140.0.0.0';
const APP_USER_AGENT = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${APP_CHROME_VERSION} Safari/537.36 (Dewey; V32; Android; ${APP_VERSION}; RELEASE)`;

// Electron documents app.userAgentFallback as the global fallback. Setting it
// before ready also covers child windows/popups; the persistent Libby session
// is set explicitly below as well.
app.userAgentFallback = APP_USER_AGENT;

let mainWindow = null;
let bifocalWindow = null;
let authWindow = null;
let libbySession = null;
let shellState = { lastNavigation: ROOT_URL };
let notifications = new Map();
let nextNotificationId = 1;
let splashWindow = null;
let bootTimer = null;
let bootCompleted = false;
let bankStore = null;

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

function diagnosticsDir() {
  const p = path.join(dataDir(), 'diagnostics');
  fs.mkdirSync(p, { recursive: true });
  return p;
}

function diagnosticsFile() {
  return path.join(diagnosticsDir(), 'libby-windows.log');
}

function diagnostic(type, data = {}) {
  try {
    fs.appendFileSync(diagnosticsFile(), JSON.stringify({
      time: new Date().toISOString(),
      type,
      ...data
    }) + '\n');
  } catch {}
}

function safeJson(value) {
  try { return JSON.parse(JSON.stringify(value)); } catch { return value; }
}

function bankFile() {
  return path.join(dataDir(), 'bank.json');
}

function loadBankStore() {
  if (bankStore) return bankStore;
  try {
    const raw = fs.readFileSync(bankFile(), 'utf8');
    bankStore = JSON.parse(raw);
    if (!bankStore || typeof bankStore !== 'object') bankStore = {};
  } catch { bankStore = {}; }
  return bankStore;
}

function saveBankStore() {
  try {
    const tmp = bankFile() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(loadBankStore(), null, 2), 'utf8');
    fs.renameSync(tmp, bankFile());
  } catch (e) { diagnostic('bank:save-error', { error: String(e) }); }
}

function bankKey(msg) {
  return String(msg.key ?? msg.id ?? msg.path ?? msg.nameKey ?? '');
}

function bankResponse(msg, name, extra = {}) {
  const response = { ...msg, ...extra, name, dest: msg.dest === 'shell' ? 'client' : (msg.dest || 'client') };
  sendShellEvent(response);
  diagnostic('bank:response', { request: msg.name, response: name, key: bankKey(msg) });
}

function handleBankMessage(msg) {
  const name = String(msg.name || '');
  const store = loadBankStore();
  const key = bankKey(msg);
  diagnostic('bank:request', { name, key, hasValue: Object.prototype.hasOwnProperty.call(msg, 'value') });

  if (name === 'bank:wipe:all') {
    bankStore = {};
    saveBankStore();
    bankResponse(msg, 'bank:wipe:all:response', { success: true });
    return true;
  }
  if (name === 'bank:delete' || name === 'bank:remove') {
    const existed = Object.prototype.hasOwnProperty.call(store, key);
    delete store[key]; saveBankStore();
    bankResponse(msg, name + ':response', { key, existed, success: true });
    return true;
  }
  if (name === 'bank:exists') {
    bankResponse(msg, name + ':response', { key, exists: Object.prototype.hasOwnProperty.call(store, key) });
    return true;
  }
  if (name === 'bank:list') {
    bankResponse(msg, name + ':response', { keys: Object.keys(store) });
    return true;
  }
  if (name === 'bank:read' || name === 'bank:get') {
    bankResponse(msg, name + ':response', { key, value: Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null, found: Object.prototype.hasOwnProperty.call(store, key) });
    return true;
  }
  if (name === 'bank:write' || name === 'bank:set' || name === 'bank:put') {
    store[key] = msg.value;
    saveBankStore();
    bankResponse(msg, name + ':response', { key, success: true, value: msg.value });
    return true;
  }
  if (name.startsWith('bank:')) {
    // Unknown bank operations still receive an explicit acknowledgement so the
    // client cannot deadlock indefinitely waiting for a native response.
    bankResponse(msg, name + ':response', { success: true, key, value: null });
    return true;
  }
  return false;
}

function createSplashWindow() {
  if (splashWindow && !splashWindow.isDestroyed()) return;
  const display = require('electron').screen.getPrimaryDisplay();
  const { x, y, width, height } = display.bounds;
  splashWindow = new BrowserWindow({
    x, y, width, height, frame: false, resizable: false, movable: false,
    fullscreen: true, alwaysOnTop: true, show: false, backgroundColor: '#111111',
    skipTaskbar: true, transparent: false, focusable: true,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false }
  });
  // Keep the splash above the app only while it is actually being shown.  The
  // previous implementation used the screen-saver z-order, which could leave
  // a dead splash permanently above the real window if its close callback was
  // interrupted.
  splashWindow.setAlwaysOnTop(true, 'floating');
  splashWindow.loadFile(path.join(__dirname, 'splash.html'));
  splashWindow.once('ready-to-show', () => {
    if (splashWindow && !splashWindow.isDestroyed()) splashWindow.show();
  });
  splashWindow.webContents.on('before-input-event', (_event, input) => {
    if (input.key === 'Escape' && input.type === 'keyDown') closeSplash(true);
  });
  splashWindow.on('closed', () => { splashWindow = null; });
}

function closeSplash(immediate = false) {
  const splash = splashWindow;
  if (!splash || splash.isDestroyed()) {
    splashWindow = null;
    return;
  }
  // Do NOT null the global reference before the delayed close. That was the
  // v5 bug: the timeout checked splashWindow after it had already been set to
  // null, so the fullscreen window could never actually close.
  splashWindow = splash;
  try { splash.setAlwaysOnTop(false); } catch {}
  if (immediate) {
    try { splash.destroy(); } catch {}
    if (splashWindow === splash) splashWindow = null;
    return;
  }
  splash.webContents.executeJavaScript(
    `document.body.style.transition='opacity .20s ease';document.body.style.opacity='0';`
  ).catch(() => {});
  setTimeout(() => {
    if (!splash.isDestroyed()) {
      try { splash.close(); } catch { try { splash.destroy(); } catch {} }
    }
    if (splashWindow === splash) splashWindow = null;
  }, 240);
}

function showBootFailure(error) {
  closeSplash();
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const detail = encodeURIComponent(String(error || 'Libby startup handshake timed out'));
  mainWindow.loadFile(path.join(__dirname, 'retry.html'), { search: `?error=${detail}` }).catch(() => {});
}

function targetWindowFor(dest, sourceContents = null) {
  if (dest === 'bifocal' && bifocalWindow && !bifocalWindow.isDestroyed()) return bifocalWindow;
  if (dest === 'auth' && authWindow && !authWindow.isDestroyed()) return authWindow;
  if (dest === 'client' && mainWindow && !mainWindow.isDestroyed()) return mainWindow;

  // When the Android code routes an event to a specific destination, prefer
  // that destination. For generic shell replies, reply to the initiating view.
  for (const win of [mainWindow, bifocalWindow, authWindow]) {
    if (win && !win.isDestroyed() && sourceContents && win.webContents.id === sourceContents.id) return win;
  }
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
}

function sendShellEvent(payload, sourceContents = null) {
  const dest = payload && payload.dest;
  const target = targetWindowFor(dest, sourceContents);
  if (!target || target.isDestroyed()) return;
  target.webContents.send('libby-shell-event', safeJson(payload));
}

function sendClientEvent(payload) {
  if (!payload.dest) payload.dest = 'client';
  sendShellEvent(payload);
}

function platformTraits(dest = 'client') {
  const win = dest === 'bifocal' ? bifocalWindow : mainWindow;
  const b = win && !win.isDestroyed() ? win.getContentBounds() : { width: 1280, height: 900 };
  const areas = {
    screenArea: { top: 0, left: 0, right: b.width, bottom: b.height },
    safeArea: { top: 0, left: 0, right: b.width, bottom: b.height },
    immersiveArea: { top: 0, left: 0, right: b.width, bottom: b.height }
  };
  return {
    name: 'platform:traits',
    dest,
    device: {
      brand: 'Microsoft', model: 'Windows PC', platform: 'Android',
      platformBuild: process.getSystemVersion(), platformVersion: process.getSystemVersion(), platformVersionInt: 0
    },
    profile: {
      fontScale: 1, invertColors: false, animationScale: 1,
      darkTheme: nativeTheme.shouldUseDarkColors, highContrast: false,
      powerMode: 'normal',
      backgroundActivity: true, storagePath: dataDir(), installer: 'electron',
      language: { app: app.getLocale(), system: app.getLocale() },
      bankWrittenByAnotherInstance: false,
      errorCorrelationId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    },
    displayAreas: areas
  };
}

// This starts from the Android 9.5.0 resource string, then applies the same
// runtime overrides cp1.capabilities() applies on Android.
function capabilities() {
  return JSON.stringify({
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
    'diagnostics:platform-settings': [
      'app',
      'app-geolocation-permissions',
      'app-notifications',
      'network',
      'app-language'
    ]
  });
}

function networkInfo(dest = 'client') {
  return {
    name: 'network:info',
    dest,
    reachable: true,
    metered: false,
    connection: 'ethernet'
  };
}

function isTrustedLibbyUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && (
      u.hostname === 'libbyapp.com' ||
      u.hostname.endsWith('.libbyapp.com') ||
      u.hostname === 'overdrive.com' ||
      u.hostname.endsWith('.overdrive.com')
    );
  } catch { return false; }
}

function configureWebContents(contents) {
  contents.setUserAgent(APP_USER_AGENT);

  contents.on('did-start-navigation', (_event, url) => {
    diagnostic('navigation:start', { url });
  });
  contents.on('did-finish-load', () => {
    diagnostic('navigation:finish', { url: contents.getURL() });
  });
  contents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    diagnostic('navigation:fail', { errorCode, errorDescription, validatedURL, isMainFrame });
    if (isMainFrame) {
      sendClientEvent({
        name: contents === (bifocalWindow && bifocalWindow.webContents) ? 'bifocal:view:failure' : 'client:view:failure',
        dest: contents === (bifocalWindow && bifocalWindow.webContents) ? 'bifocal' : 'client',
        error: errorDescription || `WebView load failed (${errorCode})`
      });
    }
  });
  contents.on('render-process-gone', (_event, details) => {
    diagnostic('renderer:gone', { reason: details.reason, exitCode: details.exitCode });
  });

  contents.setWindowOpenHandler(({ url }) => {
    if (isTrustedLibbyUrl(url)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 1100,
          height: 800,
          webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            partition: 'persist:libby',
            contextIsolation: false,
            sandbox: false,
            nodeIntegration: false
          }
        }
      };
    }
    shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });

  contents.on('will-navigate', (event, url) => {
    if (!isTrustedLibbyUrl(url)) {
      event.preventDefault();
      shell.openExternal(url).catch(() => {});
    }
  });
}

function setupSession(ses) {
  libbySession = ses;
  ses.setUserAgent(APP_USER_AGENT, 'en-US,en');
  ses.setPermissionRequestHandler((_webContents, permission, callback) => {
    // Android requests these through its native WebChromeClient/permission
    // layer. On Windows, Chromium can satisfy the equivalent permissions in
    // the persistent Libby session.
    const allowed = new Set(['geolocation', 'notifications', 'media', 'fullscreen']);
    callback(allowed.has(permission));
  });
  // Android WebView supplies the application's package in X-Requested-With.
  // Libby's native shell can use this as part of its WebView/runtime detection.
  try {
    ses.webRequest.onBeforeSendHeaders({ urls: ['https://libbyapp.com/*', 'https://*.libbyapp.com/*', 'https://overdrive.com/*', 'https://*.overdrive.com/*'] }, (details, callback) => {
      details.requestHeaders['User-Agent'] = APP_USER_AGENT;
      details.requestHeaders['X-Requested-With'] = 'com.overdrive.mobile.android.libby';
      details.requestHeaders['Accept-Language'] = app.getLocale() || 'en-US';
      // Android WebView does not identify itself as Electron through UA Client
      // Hints. Remove Electron-generated hints and provide ordinary Chrome/
      // Windows hints instead. This is important because changing only the UA
      // string still leaves Sec-CH-UA available to the server.
      for (const key of Object.keys(details.requestHeaders)) {
        if (/^sec-ch-ua/i.test(key)) delete details.requestHeaders[key];
      }
      details.requestHeaders['Sec-CH-UA'] = '"Chromium";v="140", "Google Chrome";v="140"';
      details.requestHeaders['Sec-CH-UA-Mobile'] = '?1';
      details.requestHeaders['Sec-CH-UA-Platform'] = '"Android"';
      callback({ requestHeaders: details.requestHeaders });
    });
    ses.webRequest.onCompleted({ urls: ['https://libbyapp.com/*', 'https://*.libbyapp.com/*'] }, (details) => {
      if (details.statusCode >= 400) diagnostic('network:http-error', { url: details.url, statusCode: details.statusCode, method: details.method, resourceType: details.resourceType });
    });
    ses.webRequest.onErrorOccurred({ urls: ['https://libbyapp.com/*', 'https://*.libbyapp.com/*'] }, (details) => {
      diagnostic('network:error', { url: details.url, error: details.error, method: details.method, resourceType: details.resourceType });
    });
  } catch (e) { diagnostic('webrequest:setup-error', { error: String(e) }); }

  // Persist cookies, IndexedDB, service workers, cache and local storage in the
  // same session. This is the closest Windows equivalent of Android WebView's
  // persistent Libby profile.
  ses.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const allowed = new Set([
      'geolocation',
      'notifications',
      'media',
      'clipboard-read',
      'clipboard-sanitized-write',
      'fullscreen'
    ]);
    const origin = details?.requestingUrl || webContents?.getURL?.() || '';
    const trusted = /^https:\/\/(?:[^/]+\.)?(?:libbyapp\.com|overdrive\.com)\//i.test(origin);
    callback(trusted && allowed.has(permission));
  });

  ses.setPermissionCheckHandler((_webContents, permission, requestingOrigin) => {
    const trusted = /^https:\/\/(?:[^/]+\.)?(?:libbyapp\.com|overdrive\.com)$/i.test(requestingOrigin || '') ||
      /^https:\/\/(?:[^/]+\.)?(?:libbyapp\.com|overdrive\.com)\//i.test(requestingOrigin || '');
    return trusted && ['geolocation', 'notifications', 'media', 'clipboard-read', 'clipboard-sanitized-write', 'fullscreen'].includes(permission);
  });

  ses.on('will-download', (event, item, webContents) => {
    const filename = item.getFilename();
    const target = path.join(downloadsDir(), filename);
    item.setSavePath(target);
    diagnostic('download:start', { filename, target, url: item.getURL() });
    item.on('updated', (_event, state) => {
      diagnostic('download:update', { filename, state, received: item.getReceivedBytes(), total: item.getTotalBytes() });
    });
    item.once('done', (_event, state) => {
      diagnostic('download:done', { filename, state, target });
      if (state === 'completed' && Notification.isSupported()) {
        new Notification({ title: 'Libby download complete', body: filename }).show();
      }
    });
  });

  ses.on('select-client-certificate', (event, webContents, url, list, callback) => {
    // Preserve Chromium's normal client-certificate UI/behavior rather than
    // silently selecting a certificate.
    if (list.length === 1) {
      event.preventDefault();
      callback(list[0]);
    }
  });

  // Let Chromium/WebAuthn handle platform/roaming authenticators. If multiple
  // discoverable credentials exist, choose the first one only when the user has
  // no browser account picker available; otherwise cancel rather than guessing.
  ses.on('select-webauthn-account', (_event, details, callback) => {
    if (details.accounts?.length === 1) callback(details.accounts[0].credentialId);
    else callback();
  });
}

function openAuthWindow(msg, sourceContents) {
  const data = msg;
  if (authWindow && !authWindow.isDestroyed()) {
    authWindow.show();
    if (data.url) authWindow.loadURL(data.url, { userAgent: APP_USER_AGENT });
    return;
  }

  authWindow = new BrowserWindow({
    width: 900,
    height: 760,
    minWidth: 600,
    minHeight: 500,
    parent: mainWindow || undefined,
    modal: false,
    show: false,
    title: data['text-title'] || 'Sign In',
    icon: path.join(__dirname, '..', 'assets', 'libby.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      partition: 'persist:libby',
      contextIsolation: false,
      sandbox: false,
      nodeIntegration: false
    }
  });
  configureWebContents(authWindow.webContents);
  authWindow.once('ready-to-show', () => authWindow.show());
  authWindow.on('closed', () => {
    authWindow = null;
    sendClientEvent({ name: 'authentication:cancelled', dest: 'client' });
  });
  if (data.url) authWindow.loadURL(data.url, { userAgent: APP_USER_AGENT });
  else authWindow.loadURL('about:blank');
  diagnostic('auth:open', { url: data.url || '' });
}

function openBifocalWindow(msg) {
  if (!bifocalWindow || bifocalWindow.isDestroyed()) {
    bifocalWindow = new BrowserWindow({
      width: 1100,
      height: 820,
      minWidth: 700,
      minHeight: 500,
      parent: mainWindow || undefined,
      show: false,
      title: 'Libby Reader',
      icon: path.join(__dirname, '..', 'assets', 'libby.ico'),
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        partition: 'persist:libby',
        contextIsolation: false,
        sandbox: false,
        nodeIntegration: false
      }
    });
    configureWebContents(bifocalWindow.webContents);
    bifocalWindow.loadURL('about:blank');
    bifocalWindow.on('closed', () => { bifocalWindow = null; });
  }

  const url = msg.url || msg.openbookURL || '';
  if (url) {
    bifocalWindow.loadURL(url, { userAgent: APP_USER_AGENT });
  }
  if (msg.reveal !== false) bifocalWindow.show();
  diagnostic('bifocal:open', { url, openbookURL: msg.openbookURL || '' });
}

function hideWindow(win) {
  if (win && !win.isDestroyed()) win.hide();
}

function showWindow(win) {
  if (win && !win.isDestroyed()) { win.show(); win.focus(); }
}

function injectBridgeBootSignals(win, dest) {
  if (!win || win.isDestroyed()) return;
  setTimeout(() => {
    if (!win.isDestroyed()) {
      sendShellEvent(platformTraits(dest));
      sendShellEvent(networkInfo(dest));
    }
  }, 100);
}

function executePage(win, code) {
  if (!win || win.isDestroyed()) return Promise.resolve(undefined);
  return win.webContents.executeJavaScript(code, true).catch((error) => {
    diagnostic('execute-js:error', { error: String(error), url: win.webContents.getURL() });
    return undefined;
  });
}

function b64urlToBytes(value) {
  if (typeof value !== 'string') return value;
  try {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
    return Array.from(Buffer.from(normalized, 'base64'));
  } catch { return value; }
}

function convertWebAuthnRequest(value) {
  if (!value || typeof value !== 'object') return value;
  const out = { ...value };
  if (typeof out.challenge === 'string') out.challenge = b64urlToBytes(out.challenge);
  if (out.user && typeof out.user === 'object' && typeof out.user.id === 'string') out.user = { ...out.user, id: b64urlToBytes(out.user.id) };
  for (const key of ['allowCredentials', 'excludeCredentials']) {
    if (Array.isArray(out[key])) out[key] = out[key].map((x) => ({ ...x, id: typeof x.id === 'string' ? b64urlToBytes(x.id) : x.id }));
  }
  return out;
}

function bytesToB64url(value) {
  if (!value) return '';
  return Buffer.from(new Uint8Array(value)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function webAuthnPageScript(mode, request) {
  const requestJson = JSON.stringify(convertWebAuthnRequest(request)).replace(/</g, '\\u003c');
  const name = mode === 'register' ? 'ui:passkey:register' : 'ui:passkey:authenticate';
  const responseName = mode === 'register' ? 'ui:passkey:register' : 'ui:passkey:authenticate';
  return `(async()=>{\n` +
    `const req=${requestJson};\n` +
    `const b64=(x)=>{if(!x)return '';try{const a=new Uint8Array(x);let s='';for(let i=0;i<a.length;i+=0x8000)s+=String.fromCharCode(...a.subarray(i,i+0x8000));return btoa(s).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/g,'')}catch(e){return ''}};\n` +
    `try{\n` +
    ` const publicKey=req;\n` +
    ` const cred=${mode === 'register' ? `await navigator.credentials.create({publicKey})` : `await navigator.credentials.get({publicKey})`};\n` +
    ` if(!cred)throw new DOMException('No credential returned','NotAllowedError');\n` +
    ` const r=cred.response;\n` +
    ` const credential={id:cred.id,rawId:b64(cred.rawId),type:cred.type,response:{}};\n` +
    ` if(${mode === 'register'}){credential.response={clientDataJSON:b64(r.clientDataJSON),attestationObject:b64(r.attestationObject),transports:(r.getTransports?r.getTransports():undefined)}}\n` +
    ` else{credential.response={clientDataJSON:b64(r.clientDataJSON),authenticatorData:b64(r.authenticatorData),signature:b64(r.signature),userHandle:r.userHandle?b64(r.userHandle):null}}\n` +
    ` window.dispatchEvent(new CustomEvent('bridge:receive',{detail:{name:'${responseName}',dest:'client',credential}}));\n` +
    `}catch(e){window.dispatchEvent(new CustomEvent('bridge:receive',{detail:{name:'ui:passkey:failure',dest:'client',reason:String(e&&e.message||e)}}));}\n` +
    `})()`;
}

async function handlePasskey(msg, sourceContents) {
  const sourceWin = [mainWindow, bifocalWindow, authWindow].find((w) => w && !w.isDestroyed() && w.webContents.id === sourceContents?.id) || mainWindow;
  const mode = msg.name === 'ui:passkey:register' ? 'register' : 'authenticate';
  const request = msg.webauthnRequest || msg.request || msg.options || {};
  if (!request || typeof request !== 'object') {
    sendShellEvent({ name: 'ui:passkey:failure', dest: 'client', reason: 'Missing webauthnRequest' }, sourceContents);
    return;
  }
  diagnostic('passkey:request', { mode });
  await executePage(sourceWin, webAuthnPageScript(mode, request));
}

function scheduleNotification(data) {
  const id = String(data.id || `libby-${nextNotificationId++}`);
  const delay = Math.max(0, Number(data.delayMs ?? data.delay ?? 0));
  const timer = setTimeout(() => {
    notifications.delete(id);
    if (Notification.isSupported()) {
      const n = new Notification({
        title: data.title || 'Libby',
        body: data.body || data.message || '',
        silent: !!data.silent
      });
      n.on('click', () => sendClientEvent({ name: 'notifier:receive', dest: 'client', id, action: 'click' }));
      n.show();
    }
    sendClientEvent({ name: 'notifier:receive', dest: 'client', id, notification: safeJson(data) });
  }, delay);
  notifications.set(id, timer);
  return id;
}


async function handleRosterRequest(msg, sourceContents) {
  const url = String(msg.url || '');
  let parsed;
  try { parsed = new URL(url); } catch {
    sendShellEvent({ name: 'roster:error', dest: 'client', url, error: 'Invalid roster URL' }, sourceContents);
    return;
  }
  if (parsed.protocol !== 'https:' || !(parsed.hostname === 'libbyapp.com' || parsed.hostname.endsWith('.libbyapp.com') || parsed.hostname === 'overdrive.com' || parsed.hostname.endsWith('.overdrive.com'))) {
    sendShellEvent({ name: 'roster:error', dest: 'client', url, error: 'Untrusted roster URL' }, sourceContents);
    return;
  }
  diagnostic('roster:request', { url });
  try {
    const response = await libbySession.fetch(url, {
      headers: {
        'User-Agent': APP_USER_AGENT,
        'X-Requested-With': 'com.overdrive.mobile.android.libby',
        'Accept': 'application/json, text/plain, */*'
      }
    });
    const textBody = await response.text();
    const responseHeaders = {};
    for (const [k, v] of response.headers.entries()) responseHeaders[k] = v;
    const result = {
      name: 'roster:response',
      dest: 'client',
      url,
      response: { status: response.status, headers: responseHeaders }
    };
    if (textBody) {
      try {
        const parsedBody = JSON.parse(textBody);
        if (Array.isArray(parsedBody)) result.rosters = parsedBody;
        else if (parsedBody && typeof parsedBody === 'object') result.rosters = parsedBody;
      } catch {
        // Android only includes rosters when the response is valid JSON.
      }
    }
    sendShellEvent(result, sourceContents);
  } catch (error) {
    diagnostic('roster:error', { url, error: String(error) });
    sendShellEvent({ name: 'roster:error', dest: 'client', url, error: String(error?.message || error) }, sourceContents);
  }
}

function handleRosterMessage(msg, sourceContents) {
  const name = String(msg.name || '');
  if (name === 'roster:request') { void handleRosterRequest(msg, sourceContents); return true; }
  if (name === 'roster:initialize') {
    const roster = msg.roster;
    try {
      const file = path.join(dataDir(), 'rosters.json');
      let all = {};
      try { all = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
      const id = String(roster?.id || '');
      if (id) all[id] = safeJson(roster);
      fs.writeFileSync(file, JSON.stringify(all, null, 2), 'utf8');
    } catch (e) { diagnostic('roster:initialize-error', { error: String(e) }); }
    sendShellEvent({ name: 'roster:entry:response', dest: 'client', id: roster?.id || '', success: true }, sourceContents);
    return true;
  }
  if (name === 'roster:audit') {
    sendShellEvent({ name: 'roster:audit', dest: 'client', rosters: [] }, sourceContents);
    return true;
  }
  if (name === 'roster:clean' || name === 'roster:flush:all' || name === 'roster:halt:all' ||
      name === 'roster:pause:role' || name === 'roster:resume:role' ||
      name === 'roster:wipe' || name === 'roster:wipe:all') {
    diagnostic('roster:command', { name });
    return true;
  }
  if (name.startsWith('roster:')) {
    sendShellEvent({ name: 'roster:error', dest: 'client', error: `Unsupported native roster operation: ${name}` }, sourceContents);
    return true;
  }
  return false;
}

async function handleShellMessage(raw, sourceContents) {
  let msg;
  try { msg = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (e) {
    diagnostic('bridge:parse-error', { raw: String(raw), error: String(e) });
    return;
  }
  if (!msg || typeof msg !== 'object') return;

  const name = msg.name || '';
  const data = msg.data && typeof msg.data === 'object' ? { ...msg, ...msg.data } : msg;
  diagnostic('bridge:message', { name, dest: msg.dest || '', keys: Object.keys(msg) });

  if (name === 'platform:traits') {
    sendShellEvent(platformTraits(msg.dest || 'client'), sourceContents);
    return;
  }

  if (name === 'network:info') {
    sendShellEvent(networkInfo(msg.dest || 'client'), sourceContents);
    return;
  }

  if (name === 'geolocation:coordinates') {
    const target = targetWindowFor('client', sourceContents);
    if (!target) return;
    const script = `(function(){return new Promise(r=>{if(!navigator.geolocation){r({failure:'geolocation unavailable'});return;}navigator.geolocation.getCurrentPosition(p=>r({latitude:p.coords.latitude,longitude:p.coords.longitude}),e=>r({failure:e.message||'geolocation failed'}),{enableHighAccuracy:false,timeout:10000,maximumAge:300000})})})()`;
    const result = await executePage(target, script);
    sendShellEvent({ name, dest: 'client', ...(result || { failure: 'geolocation failed' }) }, sourceContents);
    return;
  }

  if (name === 'ui:passkey:authenticate' || name === 'ui:passkey:register') {
    await handlePasskey(msg, sourceContents);
    return;
  }

  if (name === 'auth:view:open') {
    openAuthWindow(msg, sourceContents);
    return;
  }
  if (name === 'auth:view:conceal') {
    hideWindow(authWindow);
    return;
  }
  if (name === 'auth:view:reveal') {
    showWindow(authWindow);
    return;
  }
  if (name === 'auth:view:clear') {
    if (authWindow && !authWindow.isDestroyed()) {
      authWindow.loadURL('about:blank');
      hideWindow(authWindow);
    }
    return;
  }

  if (name === 'bifocal:view:open') {
    openBifocalWindow(msg);
    return;
  }
  if (name === 'bifocal:view:conceal') {
    hideWindow(bifocalWindow);
    return;
  }
  if (name === 'bifocal:view:reveal') {
    showWindow(bifocalWindow);
    return;
  }
  if (name === 'bifocal:view:clear') {
    if (bifocalWindow && !bifocalWindow.isDestroyed()) bifocalWindow.loadURL('about:blank');
    return;
  }

  if (name === 'client:view:failure' || name === 'bifocal:view:failure' || name === 'auth:view:failure') {
    diagnostic(name, { error: msg.error || '' });
    sendShellEvent(msg, sourceContents);
    return;
  }

  if (name === 'diagnostics:client:error') {
    diagnostic('client:error', { error: msg.error || null, ua: sourceContents?.getUserAgent?.() || APP_USER_AGENT });
    return;
  }
  if (name === 'diagnostics:log:email') {
    const to = encodeURIComponent(msg.toAddress || '');
    const subject = encodeURIComponent(msg.subject || 'Libby diagnostics');
    const body = encodeURIComponent(msg.body || fs.readFileSync(diagnosticsFile(), 'utf8').slice(-20000));
    shell.openExternal(`mailto:${to}?subject=${subject}&body=${body}`).catch(() => {});
    return;
  }
  if (name === 'diagnostics:show') {
    await shell.openPath(diagnosticsFile()).catch(() => {});
    return;
  }
  if (name === 'diagnostics:platform-settings') {
    const settings = msg.settings || 'app';
    const map = {
      'app-geolocation-permissions': 'ms-settings:privacy-location',
      'app-notifications': 'ms-settings:notifications',
      'app-language': 'ms-settings:regionlanguage',
      network: 'ms-settings:network-status',
      app: 'ms-settings:appsfeatures'
    };
    shell.openExternal(map[settings] || map.app).catch(() => {});
    return;
  }

  if (name === 'surface:tint') {
    if (msg.tint === 'dark' || msg.immersive === true) nativeTheme.themeSource = 'dark';
    else if (msg.tint === 'light') nativeTheme.themeSource = 'light';
    sendShellEvent(msg, sourceContents);
    return;
  }
  if (name === 'surface:orientation') {
    // Desktop windows are resizable; acknowledge the Android command without
    // pretending Windows has a phone-style orientation lock.
    sendShellEvent(msg, sourceContents);
    return;
  }
  if (name === 'client:dimensions') {
    const target = bifocalWindow && !bifocalWindow.isDestroyed() ? bifocalWindow : null;
    if (target) sendShellEvent({ name, dest: 'bifocal', width: target.getContentBounds().width, height: target.getContentBounds().height }, sourceContents);
    return;
  }

  if (name === 'environment:launch') {
    // Android's Activity_Main handles environment:launch by reloading the
    // client WebView; it does NOT answer with environment:ready. Sending a
    // synthetic ready event here was a behavioral mismatch and can leave the
    // Libby bootstrap state machine waiting in the wrong state.
    const win = BrowserWindow.fromWebContents(sourceContents);
    if (win && win === mainWindow && !win.isDestroyed()) {
      const now = Date.now();
      if (!shellState.environmentLaunchAt || now - shellState.environmentLaunchAt > 3000) {
        shellState.environmentLaunchAt = now;
        diagnostic('environment:launch', { url: win.webContents.getURL() });
        win.loadURL(ROOT_URL, { userAgent: APP_USER_AGENT });
      }
    }
    return;
  }
  if (name === 'environment:ready') {
    diagnostic('environment:ready', { dest: msg.dest || '' });
    return;
  }
  if (name === 'environment:halt') {
    diagnostic('environment:halt', { dest: msg.dest || '' });
    return;
  }

  if (name === 'platform:referrer') {
    sendShellEvent({
      name,
      dest: msg.dest || 'client',
      urls: { install: null, session: null }
    }, sourceContents);
    return;
  }

  if (name === 'email:compose') {
    const to = encodeURIComponent(data.to || data.toAddress || '');
    const subject = encodeURIComponent(data.subject || '');
    const body = encodeURIComponent(data.body || '');
    shell.openExternal(`mailto:${to}?subject=${subject}&body=${body}`).catch(() => {});
    return;
  }

  if (name === 'nav:share') {
    const text = data.text || data.url || '';
    if (text) {
      clipboard.writeText(text);
      if (Notification.isSupported()) new Notification({ title: 'Libby', body: 'Link copied to the clipboard.' }).show();
    }
    return;
  }
  if (name === 'nav:open' || name === 'nav:back' || name === 'nav:forward' || name.startsWith('nav:')) {
    shellState.lastNavigation = msg.path || msg.url || shellState.lastNavigation;
    return;
  }

  if (name.startsWith('haptic:')) return;
  if (name === 'ui:haptics') return;

  if (name === 'notifier:permission:check') {
    sendClientEvent({ name: 'notifier:permission', dest: 'client', granted: Notification.isSupported() });
    return;
  }
  if (name === 'notifier:permission:request') {
    sendClientEvent({ name: 'notifier:permission', dest: 'client', granted: Notification.isSupported() });
    return;
  }
  if (name === 'notifier:schedule') {
    const id = scheduleNotification(msg);
    sendClientEvent({ name: 'notifier:schedule:success', dest: 'client', id });
    return;
  }
  if (name === 'notifier:cancel') {
    const id = String(msg.id || '');
    const timer = notifications.get(id);
    if (timer) clearTimeout(timer);
    notifications.delete(id);
    return;
  }
  if (name === 'notifier:dismiss' || name === 'notifier:dismiss:all') return;
  if (name === 'notifier:list') {
    sendClientEvent({ name: 'notifier:list', dest: 'client', notifications: [] });
    return;
  }

  if (name.startsWith('audioproxy:')) {
    const audioDest = msg.dest || 'bifocal';
    const target = targetWindowFor(audioDest, sourceContents);
    if (name === 'audioproxy:configure') {
      sendShellEvent({ name, dest: audioDest, volume: 1, playbackRate: Number(msg.playbackRate || 1), ...(Object.prototype.hasOwnProperty.call(msg, 'sleepAtPosition') ? { sleepAtPosition: msg.sleepAtPosition } : {}) }, sourceContents);
      return;
    }
    if (target) {
      sendShellEvent(msg, sourceContents);
    }
    return;
  }

  if (name === 'speechproxy:speak' || name.startsWith('speechproxy:')) {
    // Windows Chromium's speechSynthesis is the desktop equivalent.
    sendShellEvent({ name, dest: msg.dest || 'client', supported: true }, sourceContents);
    return;
  }

  if (name === 'title:list:playable') {
    // The Android shell's startup task publishes a subscription marker first;
    // playable titles are subsequently delivered by the native bank layer.
    // Do not invent a `titles: []` response because that is not the Android
    // message shape and can make the client treat the title store as empty.
    sendShellEvent({ name: 'title:list:playable', subscribe: true, dest: 'client' }, sourceContents);
    try {
      const f = path.join(dataDir(), 'playable-titles.json');
      if (fs.existsSync(f)) {
        const titles = JSON.parse(fs.readFileSync(f, 'utf8'));
        if (Array.isArray(titles) && titles.length) {
          sendShellEvent({ name: 'title:list:playable', dest: 'client', titles }, sourceContents);
        }
      }
    } catch (e) { diagnostic('title:list:playable:error', { error: String(e) }); }
    return;
  }

  if (name.startsWith('bank:')) { handleBankMessage(msg); return; }

  // Android forwards several commands to the shell and echoes/dispatches the
  // native result. For commands without a Windows-specific implementation,
  // acknowledge them rather than dropping the message silently.
  if (msg.dest === 'shell') {
    sendShellEvent({ ...msg, dest: msg.sourceDest || 'client' }, sourceContents);
  }
}

function sendStartupSignals() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  // Android Activity_Main.A() pushes platform traits to BOTH WebViews on
  // startup/resume. Doing this proactively is important: the Libby client
  // should not have to poll for the native environment before it leaves boot.
  sendShellEvent(platformTraits('client'));
  sendShellEvent(networkInfo('client'));
  // NautilusApp's startup task (co1 case 3) proactively publishes this exact
  // subscription marker after application initialization. Libby uses it to
  // establish the native playable-title channel during boot.
  sendShellEvent({ name: 'title:list:playable', subscribe: true, dest: 'client' });
  if (bifocalWindow && !bifocalWindow.isDestroyed()) {
    sendShellEvent(platformTraits('bifocal'));
    sendShellEvent(networkInfo('bifocal'));
  }
}

function sendMediaKey(key) {
  const wins = [mainWindow, bifocalWindow].filter((w) => w && !w.isDestroyed());
  for (const win of wins) {
    const code = JSON.stringify(key);
    executePage(win, `(async()=>{\n` +
      `const k=${code};\n` +
      `try{if(navigator.mediaSession&&navigator.mediaSession.setActionHandler){const map={playpause:'play',next:'nexttrack',previous:'previoustrack'};if(k==='playpause'){const aud=[...document.querySelectorAll('audio,video')];const a=aud.find(x=>!x.paused)||aud[0];if(a){if(a.paused)await a.play();else a.pause();}}else{try{navigator.mediaSession.setActionHandler(map[k],()=>{})}catch(e){}}}}catch(e){}` +
      `})()`);
  }
}

function createWindow() {
  const partition = 'persist:libby';
  const ses = session.fromPartition(partition);
  setupSession(ses);

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
      contextIsolation: false,
      sandbox: false,
      nodeIntegration: false,
      spellcheck: true,
      webviewTag: false
    }
  });
  configureWebContents(mainWindow.webContents);

  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'File', submenu: [
      { label: 'Reload', accelerator: 'Ctrl+R', click: () => mainWindow.webContents.reload() },
      { label: 'Hard Reload', accelerator: 'Ctrl+Shift+R', click: () => mainWindow.webContents.reloadIgnoringCache() },
      { type: 'separator' },
      { label: 'Print', accelerator: 'Ctrl+P', click: () => mainWindow.webContents.print({}) },
      { label: 'Save page as PDF', click: async () => {
        const { filePath } = await dialog.showSaveDialog(mainWindow, { defaultPath: path.join(downloadsDir(), 'libby-page.pdf'), filters: [{ name: 'PDF', extensions: ['pdf'] }] });
        if (!filePath) return;
        const pdf = await mainWindow.webContents.printToPDF({ printBackground: true });
        fs.writeFileSync(filePath, pdf);
      } },
      { type: 'separator' },
      { label: 'Open diagnostics log', click: () => shell.openPath(diagnosticsFile()) },
      { label: 'Exit', role: 'quit' }
    ]},
    { label: 'View', submenu: [
      { role: 'togglefullscreen' },
      { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'resetZoom' },
      { type: 'separator' }, { role: 'toggleDevTools' }
    ]},
    { label: 'Help', submenu: [
      { label: 'Open Libby website', click: () => shell.openExternal(ROOT_URL) },
      { label: 'Open app data folder', click: () => shell.openPath(dataDir()) }
    ]}
  ]));

  mainWindow.webContents.on('console-message', (_event, details) => {
    diagnostic('console', { level: details.level, message: details.message, line: details.lineNumber, source: details.sourceId });
  });

  mainWindow.webContents.on('dom-ready', () => {
    diagnostic('dom-ready', { url: mainWindow.webContents.getURL(), ua: mainWindow.webContents.getUserAgent() });
    sendStartupSignals();
    executePage(mainWindow, `(function(){ return { bridge: !!window.BRIDGE, caps: !!(window.BRIDGE && window.BRIDGE.capabilities), env: !!(window.BRIDGE && window.BRIDGE.environment), send: !!(window.BRIDGE && window.BRIDGE.clientToShellAsJSON), ua: navigator.userAgent, webdriver: !!navigator.webdriver }; })()`)
      .then(result => diagnostic('bridge:page-check', result || {}));
  });
  mainWindow.webContents.on('did-finish-load', () => {
    sendStartupSignals();
    [50, 250, 1000, 3000].forEach((delay) => setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) sendStartupSignals();
    }, delay));
    executePage(mainWindow, `window.__LIBBY_WINDOWS_BRIDGE__={version:${JSON.stringify(APP_VERSION)},environment:${JSON.stringify(ENVIRONMENT)},native:true};`);
    // The Android shell considers the WebView healthy once its main document has
    // loaded. Give the remote client a generous handshake window, but never leave
    // the desktop app on an unexplained infinite splash.
    bootCompleted = true;
    closeSplash();
  });
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url, isMain) => {
    if (isMain) showBootFailure(`${desc || 'Navigation failed'} (${code})\n${url || ''}`);
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    // Android's launch screen belongs to the Activity and disappears when the
    // Activity's content becomes visible. Do not tie this to the remote Libby
    // bootstrap completing: a broken web bootstrap must still leave the user
    // able to see and diagnose the real loading page.
    closeSplash();
  });
  // No artificial timeout: Android keeps its launch screen until the Activity
  // content is ready. Escape remains available on the splash for recovery.
  mainWindow.on('closed', () => { mainWindow = null; });
  // Android's custom WebView calls clearCache(true) before every loadUrl().
  // Mirror that on the first desktop boot without touching persistent cookies
  // or IndexedDB.
  Promise.resolve().then(async () => {
    try { await ses.clearCache(); diagnostic('android-webview:cache-cleared'); } catch (e) { diagnostic('android-webview:cache-clear-error', { error: String(e) }); }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.loadURL(ROOT_URL, { userAgent: APP_USER_AGENT });
    }
  });
  bootTimer = setTimeout(() => {
    if (!bootCompleted && mainWindow && !mainWindow.isDestroyed()) {
      diagnostic('boot:timeout', {
        url: mainWindow.webContents.getURL(),
        readyState: 'unknown',
        ua: mainWindow.webContents.getUserAgent()
      });
      // Do not replace Libby's page with our recovery page. Android keeps the
      // WebView visible and its own recovery logic decides what to display.
      // Replacing it here can hide the real failure and makes diagnosis harder.
      sendClientEvent({
        name: 'client:view:failure', dest: 'client',
        error: 'Windows host boot timeout; Libby WebView remains visible for diagnosis.'
      });
    }
  }, 30000);

  try {
    globalShortcut.register('MediaPlayPause', () => sendMediaKey('playpause'));
    globalShortcut.register('MediaNextTrack', () => sendMediaKey('next'));
    globalShortcut.register('MediaPreviousTrack', () => sendMediaKey('previous'));
  } catch (e) { diagnostic('media-key:register-error', { error: String(e) }); }
}

ipcMain.on('bridge-capabilities-sync', (event) => {
  event.returnValue = capabilities();
});
ipcMain.on('bridge-environment-sync', (event) => {
  event.returnValue = ENVIRONMENT;
});
ipcMain.on('bridge-shell-message', (event, raw) => {
  void handleShellMessage(raw, event.sender);
});
ipcMain.on('recovery-retry', (event) => {
  const wc = event.sender;
  const win = BrowserWindow.fromWebContents(wc);
  if (!win || win.isDestroyed()) return;
  bootCompleted = false;
  win.loadURL(ROOT_URL, { userAgent: APP_USER_AGENT });
  if (win === mainWindow) createSplashWindow();
});
ipcMain.on('recovery-diagnostics', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  shell.openPath(diagnosticsFile()).catch(() => {});
  if (win && !win.isDestroyed()) win.show();
});
ipcMain.on('renderer-diagnostic', (_event, payload) => diagnostic('renderer', payload || {}));
ipcMain.handle('app-paths', () => ({ userData: app.getPath('userData'), downloads: downloadsDir(), diagnostics: diagnosticsFile() }));
ipcMain.handle('open-external', (_event, url) => {
  if (typeof url === 'string') return shell.openExternal(url);
  return false;
});

app.whenReady().then(() => {
  app.setAppUserModelId('com.overdrive.mobile.android.libby');
  createSplashWindow();
  createWindow();
  app.on('activate', () => { if (!mainWindow) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('will-quit', () => {
  try { globalShortcut.unregisterAll(); } catch {}
  for (const timer of notifications.values()) clearTimeout(timer);
  notifications.clear();
  diagnostic('app:quit');
});
