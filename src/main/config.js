'use strict';
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  homepage: 'https://duckduckgo.com',
  searchEngine: 'https://duckduckgo.com/?q=%s',
  network: {
    mode: 'builtin',            // builtin = start the bundled proxy | external = use a proxy already on host:port | direct = no proxy
    host: '127.0.0.1',          // builtin: address to listen on / external: address of your proxy
    port: 8080,
    upstream: { enabled: false, host: '', port: 0 }, // builtin only: chain to another HTTP proxy
    bypass: '<local>',          // Chromium bypass rules, e.g. "<local>;*.internal.lan"
    blockedHosts: [],
    logRequests: false,
    blockWebRTCLeak: true       // stop WebRTC from sending UDP outside the proxy (breaks WebRTC games/voice)
  },
  performance: {
    sleepAfterMinutes: 10,      // free RAM from idle background tabs; 0 disables
    hardwareAcceleration: true  // needs a restart to take effect
  },
  permissions: ['fullscreen', 'pointerLock', 'clipboard-sanitized-write', 'keyboardLock'] // add "media" for camera/mic
};

// Keep only known keys, so a hand-edited file can't inject surprises.
function merge(base, over) {
  if (base === null || typeof base !== 'object' || Array.isArray(base)) return over === undefined ? base : over;
  const out = {};
  for (const k of Object.keys(base)) out[k] = merge(base[k], over && typeof over === 'object' ? over[k] : undefined);
  return out;
}

function configPath() {
  const arg = process.argv.find((a) => a.startsWith('--config='));
  return arg ? path.resolve(arg.slice(9)) : path.join(app.getPath('userData'), 'config.json');
}

function validate(c) {
  const n = c.network;
  const portOk = (p) => Number.isInteger(p) && p >= 1 && p <= 65535;
  if (!['builtin', 'external', 'direct'].includes(n.mode)) return 'Mode must be builtin, external or direct.';
  if (typeof n.host !== 'string' || !/^[A-Za-z0-9.\-:]+$/.test(n.host)) return 'Host contains invalid characters.';
  if (!portOk(n.port)) return 'Port must be a whole number from 1 to 65535.';
  if (n.upstream.enabled && (!/^[A-Za-z0-9.\-:]+$/.test(n.upstream.host) || !portOk(n.upstream.port))) return 'Upstream proxy needs a valid host and port.';
  if (!/^https?:\/\//i.test(c.homepage)) return 'Home page must start with http:// or https://';
  if (!/^https?:\/\//i.test(c.searchEngine) || !c.searchEngine.includes('%s')) return 'Search URL must start with http(s):// and contain %s.';
  if (!(c.performance.sleepAfterMinutes >= 0)) return 'Sleep time must be 0 or more minutes.';
  if (!Array.isArray(c.permissions) || !Array.isArray(n.blockedHosts)) return 'Permissions and blocked hosts must be lists.';
  return null;
}

function load() {
  let cfg = merge(DEFAULTS, undefined);
  try { cfg = merge(DEFAULTS, JSON.parse(fs.readFileSync(configPath(), 'utf8'))); } catch { /* first run or unreadable: use defaults */ }
  for (const a of process.argv) {
    if (a.startsWith('--proxy-host=')) cfg.network.host = a.slice(13);
    if (a.startsWith('--proxy-port=')) cfg.network.port = Number(a.slice(13));
    if (a.startsWith('--proxy-mode=')) cfg.network.mode = a.slice(13);
  }
  return validate(cfg) ? merge(DEFAULTS, undefined) : cfg;
}

function save(cfg) {
  const p = configPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2));
}

module.exports = { DEFAULTS, merge, validate, load, save, configPath };
