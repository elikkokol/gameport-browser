'use strict';
/**
 * Built-in forward proxy.
 *  - Plain HTTP requests are forwarded.
 *  - HTTPS and wss:// travel through CONNECT tunnels (raw TCP, so TLS stays
 *    end-to-end and WebSocket frames are never touched).
 *  - Optional chaining to an upstream HTTP proxy, host blocklist, live stats.
 * Depends only on Node core modules so it can run (and be tested) without Electron.
 */
const http = require('http');
const net = require('net');
const { EventEmitter } = require('events');

function splitHostPort(target) {
  const m = /^\[([^\]]+)\]:(\d+)$/.exec(target) || /^([^:]+):(\d+)$/.exec(target);
  return m ? [m[1].toLowerCase(), Number(m[2])] : [null, null];
}

class ProxyServer extends EventEmitter {
  constructor() {
    super();
    this.server = null;
    this.sockets = new Set();
    this.opts = null;
    this.agent = null;
    this._resetStats();
  }

  _resetStats() {
    this.stats = { requests: 0, tunnels: 0, blocked: 0, errors: 0, bytesUp: 0, bytesDown: 0 };
  }

  get running() { return !!this.server; }
  get port() { return this.opts ? this.opts.port : null; }
  getStats() { return { ...this.stats, openSockets: this.sockets.size }; }

  start({ host = '127.0.0.1', port = 8080, upstream = null, blockedHosts = [], log = false } = {}) {
    return new Promise((resolve, reject) => {
      this.opts = { host, port, upstream, log, blocked: blockedHosts.map((h) => String(h).toLowerCase()) };
      this._resetStats();
      this.agent = new http.Agent({ keepAlive: true, maxSockets: Infinity });

      const server = http.createServer((req, res) => this._onRequest(req, res));
      server.on('connect', (req, sock, head) => this._onConnect(req, sock, head));
      server.on('connection', (s) => {
        s.setNoDelay(true); // lower latency for real-time game traffic
        this.sockets.add(s);
        s.on('close', () => this.sockets.delete(s));
      });
      server.on('clientError', (_e, s) => (s.writable ? s.end('HTTP/1.1 400 Bad Request\r\n\r\n') : s.destroy()));
      server.once('error', (err) => { this.server = null; reject(err); });
      server.listen(port, host, () => {
        server.removeAllListeners('error');
        server.on('error', (e) => this.emit('error', e));
        this.opts.port = server.address().port; // resolves port 0 -> real port
        this.server = server;
        resolve();
      });
    });
  }

  stop() {
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      const server = this.server;
      this.server = null;
      for (const s of this.sockets) s.destroy();
      this.sockets.clear();
      if (this.agent) this.agent.destroy();
      server.close(() => resolve());
    });
  }

  _blocked(host) {
    return this.opts.blocked.some((b) => host === b || host.endsWith('.' + b));
  }

  _isSelf(host, port) {
    return port === this.opts.port && ['127.0.0.1', 'localhost', '::1', this.opts.host].includes(host);
  }

  _log(msg) { if (this.opts.log) this.emit('log', msg); }

  _onRequest(req, res) {
    if (req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end('GamePort proxy is running.\n');
    }
    let u;
    try { u = new URL(req.url); } catch { res.writeHead(400); return res.end('Absolute URL required'); }
    if (u.protocol !== 'http:') { res.writeHead(501); return res.end('Use CONNECT for HTTPS'); }

    const host = u.hostname.toLowerCase();
    const port = Number(u.port) || 80;
    if (this._blocked(host)) { this.stats.blocked++; res.writeHead(403); return res.end('Blocked by proxy'); }
    if (this._isSelf(host, port)) { res.writeHead(508); return res.end('Proxy loop detected'); }

    this.stats.requests++;
    this._log(`${req.method} ${req.url}`);
    const headers = { ...req.headers };
    delete headers['proxy-connection'];
    delete headers['proxy-authorization'];

    const up = this.opts.upstream;
    const options = up
      ? { host: up.host, port: up.port, path: req.url, method: req.method, headers }
      : { hostname: host, port, path: u.pathname + u.search, method: req.method, headers, agent: this.agent };

    const out = http.request(options, (pr) => {
      res.writeHead(pr.statusCode, pr.headers);
      pr.on('data', (c) => { this.stats.bytesDown += c.length; });
      pr.pipe(res);
    });
    out.setTimeout(120000, () => out.destroy(new Error('timeout')));
    out.on('error', (err) => {
      this.stats.errors++;
      if (!res.headersSent) { res.writeHead(502); res.end(`Proxy error: ${err.code || err.message}`); } else res.destroy();
    });
    res.on('close', () => { if (!res.writableFinished) out.destroy(); });
    req.on('data', (c) => { this.stats.bytesUp += c.length; });
    req.pipe(out);
  }

  _onConnect(req, client, head) {
    const [host, port] = splitHostPort(req.url);
    if (!host || !port) return client.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    if (this._blocked(host)) { this.stats.blocked++; return client.end('HTTP/1.1 403 Forbidden\r\n\r\n'); }
    if (this._isSelf(host, port)) return client.end('HTTP/1.1 508 Loop Detected\r\n\r\n');

    this.stats.tunnels++;
    this._log(`CONNECT ${host}:${port}`);
    let established = false;

    const attach = (remote) => {
      established = true;
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) remote.write(head);
      client.on('data', (c) => { this.stats.bytesUp += c.length; });
      remote.on('data', (c) => { this.stats.bytesDown += c.length; });
      client.pipe(remote);
      remote.pipe(client);
    };

    const up = this.opts.upstream;
    const remote = net.connect(up ? up.port : port, up ? up.host : host);
    remote.setNoDelay(true);
    remote.on('error', () => {
      this.stats.errors++;
      if (!established && client.writable) client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      client.destroy();
    });
    remote.on('close', () => client.destroy());
    client.on('close', () => remote.destroy());
    client.on('error', () => remote.destroy());

    if (!up) return remote.once('connect', () => attach(remote));

    // Chain through the upstream proxy: ask it for a tunnel first.
    remote.once('connect', () => {
      remote.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`);
      let buf = Buffer.alloc(0);
      const onData = (d) => {
        buf = Buffer.concat([buf, d]);
        const end = buf.indexOf('\r\n\r\n');
        if (end === -1) return;
        remote.removeListener('data', onData);
        const status = buf.slice(0, buf.indexOf('\r\n')).toString();
        if (!/ 200 /.test(status)) { client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); return remote.destroy(); }
        const rest = buf.slice(end + 4);
        attach(remote);
        if (rest.length) client.write(rest);
      };
      remote.on('data', onData);
    });
  }
}

module.exports = { ProxyServer };
