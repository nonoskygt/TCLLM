// Prueba del buscador de agentes (tools/find-tcllm.mjs) y de la clasificación de interfaces. No toca la red real:
// levanta un servidor falso en 127.0.0.1 que responde como el Playwright MCP (GET /mcp sin sesión -> 400 "Invalid request").
//
//   node test/find-tcllm.mjs
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { probe, scan, find, localSubnets } from '../tools/find-tcllm.mjs';
import { ifaceKind, connectInfo } from '../src/access.js';

let failures = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FALL'} ${name}${extra ? ' — ' + extra : ''}`); if (!ok) failures++; };

const cache = path.join(os.tmpdir(), `tcllm-find-test-${process.pid}`);
process.env.TCLLM_CACHE = cache;
delete process.env.TCLLM_HOST;

const fake = http.createServer((req, res) => { res.statusCode = req.url === '/mcp' ? 400 : 404; res.end(req.url === '/mcp' ? 'Invalid request' : 'nope'); });
await new Promise(r => fake.listen(0, '127.0.0.1', r));
const port = fake.address().port;
const closed = http.createServer(); await new Promise(r => closed.listen(0, '127.0.0.1', r));
const closedPort = closed.address().port; await new Promise(r => closed.close(r));

try {
  check('probe: reconoce el MCP', await probe('127.0.0.1', port) === true);
  check('probe: puerto cerrado no es MCP', await probe('127.0.0.1', closedPort, 800) === false);
  check('probe: otro servidor HTTP en /mcp no es MCP', await (async () => {
    const other = http.createServer((_, res) => { res.statusCode = 200; res.end('hola'); }); await new Promise(r => other.listen(0, '127.0.0.1', r));
    const ok = await probe('127.0.0.1', other.address().port) === false; await new Promise(r => other.close(r)); return ok;
  })());

  const byName = await find({ port, names: ['no-existe.invalid', '127.0.0.1'], scanLan: false });
  check('find: salta el nombre muerto y usa el que responde', byName?.host === '127.0.0.1' && byName.via === 'nombre', JSON.stringify(byName && { host: byName.host, via: byName.via }));
  check('find: guarda la última dirección buena', fs.readFileSync(cache, 'utf8').trim() === '127.0.0.1');

  const viaCache = await find({ port, names: ['no-existe.invalid'], scanLan: false });
  check('find: si los nombres fallan usa la última dirección buena', viaCache?.host === '127.0.0.1' && viaCache.via === 'cache', JSON.stringify(viaCache && { host: viaCache.host, via: viaCache.via }));

  fs.rmSync(cache, { force: true });
  const none = await find({ port, names: ['no-existe.invalid'], scanLan: false });
  check('find: sin nombres ni caché ni barrido devuelve null', none === null);

  const hits = await scan('127.0.0', port);
  check('scan: el barrido del /24 encuentra el MCP', hits.includes('127.0.0.1'), hits.join(','));
  check('localSubnets: nunca devuelve loopback ni redes públicas', localSubnets().every(p => /^(10|192\.168|172\.(1[6-9]|2\d|3[01]))/.test(p)), localSubnets().join(','));
} finally { await new Promise(r => fake.close(r)); fs.rmSync(cache, { force: true }); }

check('ifaceKind: adaptador host-only de VirtualBox (MAC 0a:00:27) es virtual', ifaceKind('Ethernet 2', '0a:00:27:00:00:03') === 'virtual');
check('ifaceKind: Wi-Fi', ifaceKind('Wi-Fi', 'e4:60:17:ec:5c:d9') === 'wifi');
check('ifaceKind: cable', ifaceKind('Ethernet', '10:7c:61:72:76:cd') === 'ethernet');
check('ifaceKind: vEthernet (Hyper-V/WSL) es virtual', ifaceKind('vEthernet (WSL)', 'aa:bb:cc:dd:ee:ff') === 'virtual');

const ci = connectInfo(8931);
check('connectInfo: la URL por nombre usa el hostname, no una IP', ci.byName[0] === `http://${os.hostname()}:8931/mcp` && !/\d+\.\d+\.\d+\.\d+/.test(ci.byName[0]), ci.byName[0]);
check('connectInfo: las IPs virtuales no se ofrecen como dirección de LAN', ci.byIp.every(x => x.kind !== 'virtual'));

console.log(failures ? `\n${failures} fallo(s)` : '\nTodo bien');
process.exitCode = failures ? 1 : 0;
