'use strict';
const { app, BrowserWindow, WebContentsView, ipcMain, session, Menu } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');
const store = require('./config');
const { ProxyServer } = require('./proxy');

let cfg = store.load();

// ---- Chromium flags (must be set before app is ready) -----------------------
if (!cfg.performance.hardwareAcceleration) app.disableHardwareAcceleration();
app.commandLine.appendSwitch('ignore-gpu-blocklist');          // let WebGL use the GPU on more machines
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required'); // games/audio start without a click

const CHROME_H = 84; // tab strip (38) + toolbar (46)
const proxy = new ProxyServer();
proxy.on('log', (m) => console.log('[proxy]', m));
proxy.on('error', (e) => console.error('[proxy] error:', e.message));

let win = null;
let ses = null;
let netError = null;
let nextId = 1;
let activeId = null;
let fsTab = null;        // tab currently in HTML fullscreen
let overlayOpen = false; // settings dialog open -> hide page views
let pushTimer = null;
const tabs = [];

// ---- Helpers -----------------------------------------------------------------
const live = (t) => (t.view && !t.view.webContents.isDestroyed() ? t.view.webContents : null);
const activeTab = () => tabs.find((t) => t.id === activeId);
const rtcPolicy = () => (cfg.network.mode !== 'direct' && cfg.network.blockWebRTCLeak ? 'disable_non_proxied_udp' : 'default');
const isWebUrl = (u) => /^https?:\/\//i.test(u);

function toUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return cfg.homepage;
  if (isWebUrl(s) || s === 'about:blank') return s;
  const hostLike = /^(localhost|(?:[\w-]+\.)+[a-z]{2,}|\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-f:]+\])(?::\d+)?(?:[/?#]\S*)?$/i;
  if (hostLike.test(s)) return (/^(localhost|\d{1,3}(\.\d{1,3}){3}|\[)/i.test(s) ? 'http://' : 'https://') + s;
  return cfg.searchEngine.replace('%s', encodeURIComponent(s));
}

function errorPage(url, desc) {
  const esc = (x) => String(x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const n = cfg.network;
  const hint = n.mode === 'direct' ? 'Check your internet connection.'
    : `Traffic is routed through ${esc(n.host)}:${n.port} (${n.mode}). ${netError ? 'Proxy problem: ' + esc(netError) + '. ' : ''}Check that the proxy is running, or open Settings to change it.`;
  const html = `<!doctype html><meta charset="utf-8"><title>Can't load page</title>
<body style="font:15px system-ui;background:#1b1f2a;color:#e6e9f2;padding:12vh 10vw;line-height:1.5">
<h2 style="font-weight:600">This page didn't load</h2><p><b>${esc(url)}</b></p><p>${esc(desc)}</p><p>${hint}</p></body>`;
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
}

// ---- Network -----------------------------------------------------------------
function networkInfo() {
  const n = cfg.network;
  return {
    mode: n.mode, host: n.host, port: n.port, error: netError,
    running: n.mode === 'builtin' ? proxy.running : n.mode === 'external',
    stats: proxy.running ? proxy.getStats() : null
  };
}

async function applyNetwork() {
  const n = cfg.network;
  netError = null;
  await proxy.stop();
  if (n.mode === 'builtin') {
    try {
      await proxy.start({
        host: n.host, port: n.port, blockedHosts: n.blockedHosts, log: n.logRequests,
        upstream: n.upstream.enabled ? { host: n.upstream.host, port: n.upstream.port } : null
      });
    } catch (e) {
      netError = e.code === 'EADDRINUSE' ? `port ${n.port} is already in use (choose another port, or use External mode)` : e.message;
    }
  }
  if (n.mode === 'direct') {
    await ses.setProxy({ mode: 'direct' });
  } else {
    // Fixed proxy with no fallback: if the proxy is down, requests fail instead of leaking direct.
    const target = n.host === '0.0.0.0' ? '127.0.0.1' : n.host;
    await ses.setProxy({ mode: 'fixed_servers', proxyRules: `http://${target}:${n.port}`, proxyBypassRules: n.bypass });
  }
  await ses.closeAllConnections();
  for (const t of tabs) { const wc = live(t); if (wc) wc.setWebRTCIPHandlingPolicy(rtcPolicy()); }
  send('network', networkInfo());
}

// ---- Tabs --------------------------------------------------------------------
function send(channel, data) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, data);
}

function push() {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    send('state', {
      activeId,
      tabs: tabs.map((t) => {
        const wc = live(t);
        return {
          id: t.id, title: t.title || t.url || 'New tab', url: t.url, loading: t.loading, favicon: t.favicon,
          muted: t.muted, audible: t.audible, sleeping: t.sleeping,
          canGoBack: wc ? wc.navigationHistory.canGoBack() : false,
          canGoForward: wc ? wc.navigationHistory.canGoForward() : false
        };
      })
    });
  }, 30);
}

function layout() {
  if (!win || win.isDestroyed()) return;
  const [w, h] = win.getContentSize();
  const top = fsTab ? 0 : CHROME_H;
  for (const t of tabs) {
    if (!t.view) continue;
    t.view.setBounds({ x: 0, y: top, width: w, height: Math.max(0, h - top) });
    t.view.setVisible(t.id === activeId && !overlayOpen);
  }
}

function ensureView(tab) {
  if (tab.view) return tab.view;
  const view = new WebContentsView({
    webPreferences: {
      session: ses,
      sandbox: true,            // OS-level renderer sandbox
      contextIsolation: true,
      nodeIntegration: false,   // pages never get Node
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
      backgroundThrottling: true
    }
  });
  const wc = view.webContents;
  tab.view = view;
  tab.sleeping = false;
  wc.setAudioMuted(tab.muted);
  wc.setWebRTCIPHandlingPolicy(rtcPolicy());

  wc.setWindowOpenHandler(({ url }) => { if (isWebUrl(url)) createTab(url); return { action: 'deny' }; });
  wc.on('will-navigate', (e, url) => { if (!isWebUrl(url) && url !== 'about:blank') e.preventDefault(); });
  wc.on('page-title-updated', (_e, title) => { tab.title = title; push(); });
  wc.on('page-favicon-updated', (_e, icons) => { tab.favicon = icons[0] || ''; push(); });
  wc.on('did-start-loading', () => { tab.loading = true; push(); });
  wc.on('did-stop-loading', () => { tab.loading = false; push(); });
  wc.on('did-navigate', (_e, url) => { if (!url.startsWith('data:')) { tab.url = url; tab.title = ''; } push(); });
  wc.on('did-navigate-in-page', (_e, url, isMain) => { if (isMain) { tab.url = url; push(); } });
  wc.on('did-finish-load', () => { if (!wc.getURL().startsWith('data:')) tab.failed = false; });
  wc.on('did-fail-load', (_e, code, desc, url, isMain) => {
    if (!isMain || code === -3) return; // -3 = aborted by a newer navigation
    tab.failed = true;
    tab.url = url;
    wc.loadURL(errorPage(url, desc)).catch(() => {});
  });
  wc.on('render-process-gone', () => {
    setImmediate(() => { sleepTab(tab); tab.title = 'Page crashed - click the tab to reload'; push(); });
  });
  wc.on('enter-html-full-screen', () => { fsTab = tab; win.setFullScreen(true); layout(); });
  wc.on('leave-html-full-screen', () => { fsTab = null; win.setFullScreen(false); layout(); });
  // Keep window shortcuts working while a page has focus.
  wc.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    const mod = input.control || input.meta;
    if (mod && input.key.toLowerCase() === 'l') { e.preventDefault(); send('focus-url'); }
  });

  win.contentView.addChildView(view);
  view.setVisible(false);
  if (tab.url) wc.loadURL(tab.url).catch(() => {});
  layout();
  return view;
}

function createTab(url, activateIt = true) {
  const tab = { id: nextId++, url: url || cfg.homepage, title: '', favicon: '', loading: false, muted: false,
    audible: false, sleeping: false, failed: false, view: null, lastActive: Date.now() };
  tabs.push(tab);
  ensureView(tab);
  if (activateIt) activate(tab.id); else push();
  return tab;
}

function activate(id) {
  const t = tabs.find((x) => x.id === id);
  if (!t) return;
  const prev = activeTab();
  if (prev) prev.lastActive = Date.now();
  activeId = id;
  t.lastActive = Date.now();
  ensureView(t);
  layout();
  live(t)?.focus();
  push();
}

function sleepTab(tab) {
  if (!tab.view) return;
  const v = tab.view;
  tab.view = null;
  tab.sleeping = true;
  tab.loading = false;
  tab.audible = false;
  win.contentView.removeChildView(v);
  if (!v.webContents.isDestroyed()) v.webContents.close({ waitForBeforeUnload: false });
}

function closeTab(id) {
  const i = tabs.findIndex((t) => t.id === id);
  if (i < 0) return;
  const [t] = tabs.splice(i, 1);
  if (fsTab === t) { fsTab = null; win.setFullScreen(false); }
  if (t.view) {
    win.contentView.removeChildView(t.view);
    if (!t.view.webContents.isDestroyed()) t.view.webContents.close({ waitForBeforeUnload: false });
  }
  if (!tabs.length) return void createTab(cfg.homepage);
  if (activeId === id) activate(tabs[Math.min(i, tabs.length - 1)].id); else push();
}

function cycleTab(dir) {
  const i = tabs.findIndex((t) => t.id === activeId);
  if (i >= 0) activate(tabs[(i + dir + tabs.length) % tabs.length].id);
}

function navigate(input) {
  const t = activeTab();
  if (!t) return;
  t.url = toUrl(input);
  if (live(t)) live(t).loadURL(t.url).catch(() => {}); else ensureView(t);
}

function navAction(action) {
  const t = activeTab();
  const wc = t && live(t);
  if (!wc) return;
  const h = wc.navigationHistory;
  if (action === 'back' && h.canGoBack()) h.goBack();
  else if (action === 'forward' && h.canGoForward()) h.goForward();
  else if (action === 'home') navigate(cfg.homepage);
  else if (action === 'reload') { if (t.loading) wc.stop(); else if (t.failed) wc.loadURL(t.url).catch(() => {}); else wc.reload(); }
}

function toggleMute(id) {
  const t = tabs.find((x) => x.id === id);
  if (!t) return;
  t.muted = !t.muted;
  live(t)?.setAudioMuted(t.muted);
  push();
}

// ---- Window, menu, IPC ----------------------------------------------------------
function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 800, minWidth: 640, minHeight: 420, show: false, autoHideMenuBar: true,
    backgroundColor: '#1b1f2a', title: 'GamePort Browser',
    webPreferences: {
      preload: path.join(__dirname, '../ui/preload.js'),
      session: ses, // even the UI's favicon requests use the proxy
      contextIsolation: true, sandbox: true, nodeIntegration: false
    }
  });
  win.loadFile(path.join(__dirname, '../ui/index.html'));
  win.once('ready-to-show', () => win.show());
  win.on('resize', layout);
  win.on('enter-full-screen', layout);
  win.on('leave-full-screen', layout);
  win.on('closed', () => { win = null; });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.once('did-finish-load', () => { createTab(cfg.homepage); send('network', networkInfo()); });
}

function buildMenu() {
  const t = (label, accelerator, click) => ({ label, accelerator, click });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    { label: 'Browser', submenu: [
      t('New Tab', 'CmdOrCtrl+T', () => createTab(cfg.homepage)),
      t('Close Tab', 'CmdOrCtrl+W', () => activeId && closeTab(activeId)),
      t('Next Tab', 'Ctrl+Tab', () => cycleTab(1)),
      t('Previous Tab', 'Ctrl+Shift+Tab', () => cycleTab(-1)),
      t('Focus Address Bar', 'CmdOrCtrl+L', () => send('focus-url')),
      t('Reload', 'CmdOrCtrl+R', () => navAction('reload')),
      t('Reload (F5)', 'F5', () => navAction('reload')),
      t('Back', 'Alt+Left', () => navAction('back')),
      t('Forward', 'Alt+Right', () => navAction('forward')),
      t('Settings', 'CmdOrCtrl+,', () => send('open-settings')),
      { type: 'separator' },
      t('Page Developer Tools', 'F12', () => live(activeTab() || {})?.openDevTools({ mode: 'detach' })),
      { role: 'togglefullscreen' },
      { role: 'quit' }
    ] },
    { role: 'editMenu' },
    { label: 'Help', submenu: [
      t('Run capability self-test', null, () => {
        const wc = live(activeTab() || {});
        if (wc) wc.loadURL(pathToFileURL(path.join(__dirname, '../ui/selftest.html')).href).catch(() => {});
      })
    ] }
  ]));
}

function setupSession() {
  ses = session.fromPartition('persist:browser');
  const allow = () => new Set(cfg.permissions); // read live so Settings changes apply immediately
  ses.setPermissionRequestHandler((_wc, permission, cb) => cb(allow().has(permission)));
  ses.setPermissionCheckHandler((_wc, permission) => allow().has(permission));
}

function setupIpc() {
  const trusted = (e) => win && e.sender === win.webContents; // only our own UI may call these
  const on = (ch, fn) => ipcMain.handle(ch, (e, ...a) => (trusted(e) ? fn(...a) : undefined));

  on('tab:new', (url) => { createTab(url ? toUrl(url) : cfg.homepage); });
  on('tab:close', (id) => closeTab(id));
  on('tab:activate', (id) => activate(id));
  on('tab:mute', (id) => toggleMute(id));
  on('nav', (action) => navAction(action));
  on('navigate', (input) => navigate(input));
  on('overlay', (open) => { overlayOpen = !!open; layout(); });
  on('network:get', () => networkInfo());
  on('settings:get', () => cfg);
  on('media:toggle', async () => {
    const wc = live(activeTab() || {});
    if (!wc) return;
    await wc.executeJavaScript(`(() => {
      const m = [...document.querySelectorAll('video,audio')];
      const playing = m.some((x) => !x.paused);
      m.forEach((x) => (playing ? x.pause() : x.play().catch(() => {})));
    })()`).catch(() => {});
  });
  on('settings:save', async (incoming) => {
    try {
      const next = store.merge(store.DEFAULTS, incoming);
      const err = store.validate(next);
      if (err) return { ok: false, error: err };
      cfg = next;
      store.save(cfg);
      await applyNetwork();
      return { ok: true, network: networkInfo() };
    } catch (e) { return { ok: false, error: e.message }; }
  });
}

// Free memory from idle background tabs and keep audio indicators fresh.
function startResourceManager() {
  setInterval(() => {
    const limit = cfg.performance.sleepAfterMinutes * 60000;
    const now = Date.now();
    let changed = false;
    for (const t of tabs.slice()) {
      const wc = live(t);
      if (!wc) continue;
      const audible = wc.isCurrentlyAudible();
      if (audible !== t.audible) { t.audible = audible; changed = true; }
      if (limit > 0 && t.id !== activeId && !audible && !t.loading && now - t.lastActive > limit) { sleepTab(t); changed = true; }
    }
    if (changed) push();
  }, 3000);
}

app.whenReady().then(async () => {
  setupSession();
  setupIpc();
  buildMenu();
  await applyNetwork();       // proxy is up before the first page request
  createWindow();
  startResourceManager();
  app.on('activate', () => { if (!win) createWindow(); });
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { proxy.stop(); });
