'use strict';
// Runs without Electron:  npm test
const assert = require('assert');
const http = require('http');
const net = require('net');
const { ProxyServer } = require('../src/main/proxy');

const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));

// CONNECT through a proxy and return the raw tunnel socket (or the status code on refusal)
function tunnel(proxyPort, target) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: proxyPort, method: 'CONNECT', path: target });
    req.on('connect', (res, sock) => resolve({ status: res.statusCode, sock }));
    req.on('error', reject);
    req.end();
  });
}

const echoThrough = ({ sock }) => new Promise((resolve) => { sock.once('data', (d) => { sock.destroy(); resolve(d.toString()); }); sock.write('ping'); });

(async () => {
  const web = http.createServer((req, res) => res.end('hello from ' + req.headers.host));
  const echo = net.createServer((s) => s.pipe(s));
  const webPort = await listen(web);
  const echoPort = await listen(echo);

  const a = new ProxyServer();
  await a.start({ host: '127.0.0.1', port: 0 });
  const b = new ProxyServer(); // chained: b -> a -> target
  await b.start({ host: '127.0.0.1', port: 0, upstream: { host: '127.0.0.1', port: a.port } });
  const c = new ProxyServer();
  await c.start({ host: '127.0.0.1', port: 0, blockedHosts: ['blocked.test'] });

  // 1. Plain HTTP forwarding
  const body = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: a.port, path: `http://127.0.0.1:${webPort}/x`, headers: { host: `127.0.0.1:${webPort}` } }, (res) => {
      let s = ''; res.on('data', (d) => (s += d)); res.on('end', () => resolve(s));
    }).on('error', reject);
  });
  assert.strictEqual(body, `hello from 127.0.0.1:${webPort}`);
  console.log('ok  HTTP forwarding');

  // 2. CONNECT tunnel (what HTTPS and wss:// use): raw bytes must round-trip
  const t1 = await tunnel(a.port, `127.0.0.1:${echoPort}`);
  assert.strictEqual(t1.status, 200);
  assert.strictEqual(await echoThrough(t1), 'ping');
  console.log('ok  CONNECT tunnel');

  // 3. Chained through an upstream proxy
  const t2 = await tunnel(b.port, `127.0.0.1:${echoPort}`);
  assert.strictEqual(t2.status, 200);
  assert.strictEqual(await echoThrough(t2), 'ping');
  assert.ok(a.getStats().tunnels >= 2, 'upstream saw the chained tunnel');
  console.log('ok  upstream chaining');

  // 4. Blocklist and loop protection
  assert.strictEqual((await tunnel(c.port, 'ads.blocked.test:443')).status, 403);
  assert.strictEqual((await tunnel(a.port, `127.0.0.1:${a.port}`)).status, 508);
  console.log('ok  blocklist and loop protection');

  // 5. Unreachable target yields 502 instead of hanging
  const dead = net.createServer(); const deadPort = await listen(dead); dead.close();
  assert.strictEqual((await tunnel(a.port, `127.0.0.1:${deadPort}`)).status, 502);
  console.log('ok  unreachable target returns 502');

  await Promise.all([a.stop(), b.stop(), c.stop()]);
  web.close(); echo.close();
  console.log('\nAll proxy tests passed.');
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
