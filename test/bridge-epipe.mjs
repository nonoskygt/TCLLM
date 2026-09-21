// Regresión: una escritura al sidecar en vuelo cuando el proceso muere no debe tumbar TCLLM (crash.log 2026-09-21: write EPIPE).
// Uso: node test/bridge-epipe.mjs
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';

const { bridge } = await import('../src/bridge.js');

let uncaught = null;
const onUncaught = (e) => { uncaught = e; };
process.on('uncaughtException', onUncaught);

// Sidecar falso: no lee su stdin y muere a los 400 ms. Una escritura grande queda en vuelo en el pipe cuando el proceso
// desaparece → el stream stdin emite 'error' (EOF/EPIPE). Sin listener, eso es un uncaughtException que tumba TCLLM.
const fake = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 400)'], { stdio: ['pipe', 'pipe', 'pipe'] });
bridge.proc = fake; bridge.starting = null;
bridge._wire?.(fake);   // engancha los handlers igual que start() (existe tras el arreglo)
await new Promise(r => setTimeout(r, 100));

let rejected = null;
const big = bridge._send({ op: 'ping', relleno: 'x'.repeat(1 << 20) }, 3000).catch(e => { rejected = e; });
await new Promise(r => fake.once('exit', r));
await new Promise(r => setTimeout(r, 400));
await big;

process.off('uncaughtException', onUncaught);   // antes de las aserciones: si no, un fallo se tragaría en el handler
assert.equal(uncaught, null, 'no debe haber uncaughtException: ' + (uncaught && uncaught.message));
assert.ok(rejected, 'la petición debe rechazarse con un error, no colgarse');
console.log('OK: sidecar muerto con escritura en vuelo → petición rechazada (' + rejected.message + '), sin uncaughtException');
