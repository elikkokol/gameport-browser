'use strict';
const $ = (id) => document.getElementById(id);
let state = { tabs: [], activeId: null };
let net = null;
let current = null;      // settings last loaded from the main process
let statsTimer = null;

function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v);
  }
  el.append(...kids);
  return el;
}

const active = () => state.tabs.find((t) => t.id === state.activeId);

// ---- Rendering -----------------------------------------------------------------
function renderTabs() {
  const strip = $('tabs');
  strip.textContent = '';
  for (const t of state.tabs) {
    const icon = t.loading ? h('span', { class: 'spin' })
      : t.favicon ? h('img', { class: 'fav', src: t.favicon, alt: '' })
      : h('span', { class: 'fav' });
    const tab = h('div', {
      class: 'tab' + (t.id === state.activeId ? ' active' : '') + (t.sleeping ? ' sleeping' : ''),
      role: 'tab', title: t.url || '',
      onclick: () => api.activateTab(t.id),
      onauxclick: (e) => { if (e.button === 1) api.closeTab(t.id); }
    }, icon, h('span', { class: 'title' }, t.title));

    if (t.audible || t.muted) {
      tab.append(h('button', {
        class: 'snd', title: t.muted ? 'Unmute tab' : 'Mute tab',
        onclick: (e) => { e.stopPropagation(); api.muteTab(t.id); }
      }, t.muted ? '\u{1F507}' : '\u{1F50A}'));
    }
    tab.append(h('button', {
      class: 'x', title: 'Close tab', 'aria-label': 'Close tab',
      onclick: (e) => { e.stopPropagation(); api.closeTab(t.id); }
    }, '\u2715'));
    strip.append(tab);
  }
}

function renderToolbar() {
  const t = active();
  $('back').disabled = !t || !t.canGoBack;
  $('forward').disabled = !t || !t.canGoForward;
  $('reload').textContent = t && t.loading ? '\u2715' : '\u27F3';
  $('reload').title = t && t.loading ? 'Stop loading' : 'Reload (F5)';
  $('mute').textContent = t && t.muted ? '\u{1F507}' : '\u{1F50A}';
  $('mute').title = t && t.muted ? 'Unmute this tab' : 'Mute this tab';
  if (document.activeElement !== $('url')) $('url').value = t && t.url && !t.url.startsWith('file:') ? t.url : '';
}

function renderNet() {
  const chip = $('net');
  if (!net) return;
  const where = `${net.host}:${net.port}`;
  const label = net.mode === 'direct' ? 'Direct' : net.mode === 'builtin' ? `Proxy ${where}` : `External ${where}`;
  chip.textContent = net.error ? `${label} - not running` : label;
  chip.className = 'chip ' + (net.mode === 'direct' ? '' : net.error || !net.running ? 'bad' : 'ok');
  chip.title = net.error ? `Proxy problem: ${net.error}` : 'Network route. Click to change.';
}

function render() { renderTabs(); renderToolbar(); }

// ---- Toolbar wiring ------------------------------------------------------------
$('newtab').onclick = () => api.newTab();
$('back').onclick = () => api.nav('back');
$('forward').onclick = () => api.nav('forward');
$('reload').onclick = () => api.nav('reload');
$('home').onclick = () => api.nav('home');
$('media').onclick = () => api.toggleMedia();
$('mute').onclick = () => { const t = active(); if (t) api.muteTab(t.id); };
$('gear').onclick = openSettings;
$('net').onclick = openSettings;

$('url').addEventListener('focus', () => $('url').select());
$('url').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { api.navigate($('url').value); $('url').blur(); }
  if (e.key === 'Escape') { $('url').blur(); renderToolbar(); }
});
$('url').addEventListener('blur', renderToolbar);

api.on('state', (s) => { state = s; render(); });
api.on('network', (n) => { net = n; renderNet(); });
api.on('focus-url', () => $('url').focus());
api.on('open-settings', openSettings);
api.getNetwork().then((n) => { net = n; renderNet(); });

// ---- Settings ------------------------------------------------------------------
const f = {
  mode: $('s-mode'), host: $('s-host'), port: $('s-port'), upEn: $('s-up-en'), upHost: $('s-up-host'),
  upPort: $('s-up-port'), bypass: $('s-bypass'), blocked: $('s-blocked'), rtc: $('s-rtc'),
  home: $('s-home'), search: $('s-search'), media: $('s-media'), sleep: $('s-sleep')
};

function syncDisabled() {
  const m = f.mode.value;
  f.host.disabled = f.port.disabled = f.bypass.disabled = f.rtc.disabled = m === 'direct';
  f.upEn.disabled = f.blocked.disabled = m !== 'builtin';
  f.upHost.disabled = f.upPort.disabled = m !== 'builtin' || !f.upEn.checked;
}
[f.mode, f.upEn].forEach((el) => el.addEventListener('change', syncDisabled));

async function openSettings() {
  current = await api.getSettings();
  const n = current.network;
  f.mode.value = n.mode; f.host.value = n.host; f.port.value = n.port;
  f.upEn.checked = n.upstream.enabled; f.upHost.value = n.upstream.host; f.upPort.value = n.upstream.port || '';
  f.bypass.value = n.bypass; f.blocked.value = n.blockedHosts.join(', '); f.rtc.checked = n.blockWebRTCLeak;
  f.home.value = current.homepage; f.search.value = current.searchEngine;
  f.media.checked = current.permissions.includes('media');
  f.sleep.value = current.performance.sleepAfterMinutes;
  $('s-error').hidden = true;
  syncDisabled();
  $('settings').hidden = false;
  api.overlay(true);
  pollStats();
  statsTimer = setInterval(pollStats, 2000);
  f.mode.focus();
}

function closeSettings() {
  $('settings').hidden = true;
  clearInterval(statsTimer);
  api.overlay(false);
}

async function pollStats() {
  net = await api.getNetwork();
  renderNet();
  const s = net.stats;
  $('s-stats').textContent = s
    ? `Built-in proxy is running: ${s.requests} HTTP requests, ${s.tunnels} tunnels, ${s.openSockets} open connections, ${(s.bytesDown / 1048576).toFixed(1)} MB down, ${(s.bytesUp / 1048576).toFixed(1)} MB up.`
    : net.error ? `Proxy problem: ${net.error}.` : '';
}

$('settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const next = structuredClone(current);
  const n = next.network;
  n.mode = f.mode.value; n.host = f.host.value.trim(); n.port = Number(f.port.value);
  n.upstream = { enabled: f.upEn.checked, host: f.upHost.value.trim(), port: Number(f.upPort.value) || 0 };
  n.bypass = f.bypass.value.trim();
  n.blockedHosts = f.blocked.value.split(',').map((x) => x.trim()).filter(Boolean);
  n.blockWebRTCLeak = f.rtc.checked;
  next.homepage = f.home.value.trim(); next.searchEngine = f.search.value.trim();
  next.performance.sleepAfterMinutes = Number(f.sleep.value);
  const perms = new Set(next.permissions);
  f.media.checked ? perms.add('media') : perms.delete('media');
  next.permissions = [...perms];

  const res = await api.saveSettings(next);
  if (!res.ok) { $('s-error').textContent = res.error; $('s-error').hidden = false; return; }
  net = res.network; renderNet();
  if (net.error) { $('s-error').textContent = `Saved, but the proxy could not start: ${net.error}.`; $('s-error').hidden = false; return; }
  closeSettings();
});
$('s-cancel').onclick = closeSettings;
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('settings').hidden) closeSettings(); });
