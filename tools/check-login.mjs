// Comprueba, desde un contexto de agente REAL (sesión MCP nueva contra el Playwright MCP de TCLLM), si un sitio abre
// logueado con el storage-state actual. Abre una ventana visible, navega, informa y cierra.
//
//   tcllm check-login <url> [<url>...] [--mcp http://192.168.2.20:8931/mcp] [--keep]
//
// Para cada URL imprime la URL final y el título. Si la URL final o el título huelen a login (login, signin, auth,
// "iniciar sesión", "sign in"...), lo marca como NO LOGUEADO. --keep deja la sesión abierta (la ventana se queda)
// para que puedas mirarla; Ctrl+C la cierra.
import { McpHttpClient, defaultUrl } from './mcp-client.mjs';

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : def; };
const mcpUrl = opt('--mcp', defaultUrl());
const keep = args.includes('--keep');
const urls = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--mcp');
if (!urls.length) { console.error('Uso: tcllm check-login <url> [<url>...] [--mcp <url del mcp>] [--keep]'); process.exit(2); }

const LOGIN_HINT = /login|signin|sign-in|sign_in|auth|sso|iniciar sesi|inicio de sesi|sign in|log in|bienvenid|welcome|accounts\.google\.com/i;
const c = new McpHttpClient('check-login', mcpUrl);
let failures = 0;
try {
  await c.init();
  for (const url of urls) {
    try {
      await c.call('browser_navigate', { url });
      await c.call('browser_wait_for', { time: 3 }).catch(() => {});
      const snap = await c.call('browser_snapshot', {});
      const finalUrl = (snap.match(/Page URL: (.*)/) || [])[1] || '?';
      const title = (snap.match(/Page Title: (.*)/) || [])[1] || '?';
      const looksLogin = LOGIN_HINT.test(finalUrl) || LOGIN_HINT.test(title);
      if (looksLogin) failures++;
      console.log(`${looksLogin ? 'NO LOGUEADO' : 'OK        '}  ${url}\n             -> ${finalUrl}  [${title.slice(0, 70)}]`);
    } catch (e) {
      failures++;
      console.log(`ERROR       ${url}\n             ${e.message.split('\n')[0].slice(0, 200)}`);
    }
  }
} catch (e) {
  failures++;
  console.log(`ERROR conectando al MCP ${mcpUrl}: ${e.message.split('\n')[0]}`);
} finally {
  if (keep && c.sessionId) {
    console.log('Sesión abierta (--keep). Ctrl+C para cerrarla.');
    process.on('SIGINT', async () => { await c.close().catch(() => {}); process.exit(failures ? 1 : 0); });
    await new Promise(() => {});
  }
  await c.close().catch(() => {});
}
process.exit(failures ? 1 : 0);
