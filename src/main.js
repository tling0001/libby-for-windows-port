const { app, BrowserWindow, session, shell, ipcMain, dialog, Notification, nativeTheme, globalShortcut, Menu } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT_URL = 'https://libbyapp.com';
const APP_VERSION = '9.5.0';
const PRODUCT = 'Libby';
const ENVIRONMENT = 'charlie';
const APP_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 (Dewey; V32; Android; 9.5.0; RELEASE)';

let mainWindow;
let shellState = { lastNavigation: ROOT_URL };

function dataDir() {
  return path.join(app.getPath('userData'), 'libby');
}

function downloadsDir() {
  const p = path.join(app.getPath('downloads'), 'Libby');
  fs.mkdirSync(p, { recursive: true });
  return p;
}

function sendShellEvent(payload) { sendBridgeEvent(payload); }

function platformTraits() {
  return { name: 'platform:traits', dest: 'client', device: {
    brand: 'Microsoft', model: 'Windows PC', platform: 'Android',
    platformBuild: process.getSystemVersion(), platformVersion: '9.5.0', platformVersionInt: 0
  }, profile: { darkTheme: nativeTheme.shouldUseDarkColors, highContrast: false,
    storagePath: dataDir(), installer: 'electron', language: { app: app.getLocale(), system: app.getLocale() } } };
}

function capabilities() {
  return { bank:true, 'ui:bifocal-webview':true, 'ui:auth-webview':true, 'network:info':true,
    'debug:diagnostics-option':false, 'debug:download-queue':false, 'diagnostics:log':true,
    'audio:autonomous':true, geolocation:true, 'ui:haptics':true, 'feedback:store':null,
    'email:compose':true, 'platform:traits':true, 'audio:sleep-at-position':true,
    'audio:milestones':true, 'ui:dictionary':true, 'ui:oauth':'dewey-oauth',
    'notifier:schedule':true, 'notifier:badge':false, 'notifier:list':null,
    'nav:share':['url','text','image','file'] };
}

async function handleShellMessage(raw) {
  let msg; try { msg = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return; }
  if (!msg || typeof msg !== 'object') return;
  const name = msg.name || '', data = msg.data || msg;
  if (name === 'environment:launch') { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.reload(); return; }
  if (name === 'environment:ready') { setTimeout(sendStartupEvents, 0); return; }
  if (name === 'environment:halt') return;
  if (name === 'platform:traits') { sendBridgeEvent(platformTraits()); return; }
  if (name === 'network:info') { sendBridgeEvent({name,dest:msg.dest||'client',reachable:true,metered:false,connection:'ethernet'}); return; }
  if (name === 'title:list:playable') { sendBridgeEvent({name,dest:'client',titles:[]}); return; }
  if (name.startsWith('nav:')) { shellState.lastNavigation = msg.path || msg.url || ROOT_URL; return; }
  if (name === 'email:compose') { const to=encodeURIComponent(data.to||''), subject=encodeURIComponent(data.subject||''), body=encodeURIComponent(data.body||''); await shell.openExternal(`mailto:${to}?subject=${subject}&body=${body}`).catch(()=>{}); return; }
  if (name === 'nav:share') { const text=data.text||data.url||''; if(text){await require('electron').clipboard.writeText(text).catch(()=>{}); if(mainWindow&&!mainWindow.isDestroyed()) new Notification({title:'Libby',body:'Link copied to the clipboard.'}).show();} return; }
  if (name === 'ui:haptics') return;
  if (name === 'notifier:schedule') { const title=data.title||'Libby', body=data.body||data.message||'', delay=Math.max(0,Number(data.delayMs||data.delay||0)); setTimeout(()=>{if(Notification.isSupported()) new Notification({title,body}).show();},delay); return; }
  if (name === 'audioproxy:configure') { sendBridgeEvent({name,dest:'bifocal',volume:1,playbackRate:1}); }
}
function sendBridgeEvent(payload) { if(mainWindow&&!mainWindow.isDestroyed()) mainWindow.webContents.send('libby-bridge-receive',payload); }
function sendStartupEvents() { sendBridgeEvent(platformTraits()); sendBridgeEvent({name:'network:info',dest:'client',reachable:true,metered:false,connection:'ethernet'}); sendBridgeEvent({name:'title:list:playable',dest:'client',subscribe:true}); }

function createWindow() {
  const partition = 'persist:libby';
  const ses = session.fromPartition(partition);
  ses.setUserAgent(APP_USER_AGENT);

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

  // Downloads: preserve Libby's downloadable content rather than losing it to a browser temp folder.
  ses.on('will-download', (event, item) => {
    const filename = item.getFilename();
    const target = path.join(downloadsDir(), filename);
    item.setSavePath(target);
    item.once('done', (_e, state) => {
      if (state === 'completed' && Notification.isSupported()) {
        new Notification({ title: 'Libby download complete', body: filename }).show();
      }
    });
  });

  ses.setPermissionRequestHandler((webContents, permission, callback) => {
    const allowed = ['geolocation', 'notifications', 'media', 'clipboard-read', 'clipboard-sanitized-write'];
    callback(allowed.includes(permission));
  });

  ses.setPermissionCheckHandler((_webContents, permission) => {
    return ['geolocation', 'notifications', 'media', 'clipboard-read', 'clipboard-sanitized-write'].includes(permission);
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://libbyapp.com') || url.startsWith('https://www.libbyapp.com')) {
      return { action: 'allow' };
    }
    shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!/^https:\/\/([a-z0-9-]+\.)*libbyapp\.com\//i.test(url) && !/^https:\/\/[^/]*overdrive\.com\//i.test(url)) {
      event.preventDefault();
      shell.openExternal(url).catch(() => {});
    }
  });

  mainWindow.webContents.on('did-finish-load', () => { sendStartupEvents(); });
  mainWindow.webContents.on('did-navigate', (_event, url) => { shellState.lastNavigation = url; });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.loadURL(ROOT_URL);

  // Windows media keys: ask the page's Media Session implementation to handle them.
  const mediaCommands = {
    MediaPlayPause: `navigator.mediaSession?.setActionHandler ? null : null`,
    MediaNextTrack: `navigator.mediaSession?.setActionHandler ? null : null`
  };
  try {
    globalShortcut.register('MediaPlayPause', () => mainWindow?.webContents.send('libby-media-key', 'playpause'));
    globalShortcut.register('MediaNextTrack', () => mainWindow?.webContents.send('libby-media-key', 'next'));
    globalShortcut.register('MediaPreviousTrack', () => mainWindow?.webContents.send('libby-media-key', 'previous'));
  } catch {}
}

ipcMain.handle('bridge-capabilities', () => capabilities());
ipcMain.handle('bridge-environment', () => ENVIRONMENT);
ipcMain.on('bridge-shell-message', (_event, raw) => { void handleShellMessage(raw); });
ipcMain.handle('app-paths', () => ({ userData: app.getPath('userData'), downloads: downloadsDir() }));
ipcMain.handle('open-external', (_event, url) => shell.openExternal(url));

app.whenReady().then(() => {
  app.setAppUserModelId('com.overdrive.mobile.windows.libby');
  createWindow();
  app.on('activate', () => { if (!mainWindow) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('will-quit', () => { try { globalShortcut.unregisterAll(); } catch {} });
