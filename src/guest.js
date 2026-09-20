// Ejecución de comandos y copia de archivos DENTRO del guest (Guest Additions / guestcontrol).
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { run, VBoxError } from './vbox.js';
import { vmCredentials } from './config.js';
import { log } from './log.js';

const L = log('guest');
const PS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

function creds(vm) {
  const c = vmCredentials(vm);
  if (!c || !c.user) throw new Error(`La VM "${vm}" no tiene credenciales en config.json (vms.${vm}.user/password)`);
  return c;
}

/** Envoltorio: salida UTF-8, sin progreso (CLIXML), errores como texto. */
function wrap(code) {
  return `[Console]::OutputEncoding=[Text.Encoding]::UTF8; $ProgressPreference='SilentlyContinue'; & { ${code} } 2>&1 | Out-String -Width 200`;
}
const encode = (code) => Buffer.from(code, 'utf16le').toString('base64');

/** Ejecuta PowerShell como el usuario del guest (token UAC filtrado). Devuelve stdout+stderr como texto. */
export async function runPS(vm, code, { timeoutMs = 120000 } = {}) {
  const c = creds(vm);
  const out = await run([
    'guestcontrol', vm, 'run', '--username', c.user, '--password', c.password, '--timeout', String(timeoutMs),
    '--exe', PS, '--', 'powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encode(wrap(code)),
  ], { timeout: timeoutMs + 15000, allowFail: true });
  return out.replace(/\r\n/g, '\n').replace(/\n+$/, '');
}

/** Ejecuta PowerShell ELEVADO (High IL) sin prompt UAC (requiere ConsentPromptBehaviorAdmin=0 en el guest). */
export async function runPSAdmin(vm, code, { timeoutMs = 300000 } = {}) {
  const c = creds(vm);
  const tag = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const guestDir = 'C:\\ProgramData\\tcllm';
  const script = `${guestDir}\\cmd_${tag}.ps1`, outFile = `${guestDir}\\out_${tag}.txt`;
  const local = path.join(os.tmpdir(), `tcllm-admin-${tag}.ps1`);
  await fs.writeFile(local, '\ufeff' + code, 'utf8'); // BOM: PowerShell lee UTF-8 con acentos
  await runPS(vm, `New-Item -ItemType Directory -Force '${guestDir}' | Out-Null`);
  await run(['guestcontrol', vm, 'copyto', '--username', c.user, '--password', c.password, '--target-directory', guestDir, local]);
  await fs.unlink(local).catch(() => {});
  const launcher = `Move-Item '${guestDir}\\${path.basename(local)}' '${script}' -Force; ` +
    `Start-Process powershell -Verb RunAs -WindowStyle Hidden -Wait -ArgumentList "-NoProfile -ExecutionPolicy Bypass -Command [Console]::OutputEncoding=[Text.Encoding]::UTF8; \\$ProgressPreference='SilentlyContinue'; & { . '${script}' } 2>&1 | Out-String -Width 200 | Out-File -Encoding utf8 '${outFile}'"; ` +
    `Get-Content '${outFile}' -Raw -ErrorAction SilentlyContinue; Remove-Item '${script}','${outFile}' -Force -ErrorAction SilentlyContinue`;
  return (await runPS(vm, launcher, { timeoutMs })).trim();
}

export async function copyTo(vm, localPath, guestDir) {
  const c = creds(vm);
  await run(['guestcontrol', vm, 'copyto', '--username', c.user, '--password', c.password, '--target-directory', guestDir, localPath]);
}
export async function copyFrom(vm, guestPath, localDir) {
  const c = creds(vm);
  await run(['guestcontrol', vm, 'copyfrom', '--username', c.user, '--password', c.password, '--target-directory', localDir, guestPath]);
}

/** ¿Responde el servicio de guest control? (VBoxService arrancado y sesión lista) */
export async function ready(vm) {
  try { return (await runPS(vm, '"tcllm-ready"', { timeoutMs: 20000 })).includes('tcllm-ready'); }
  catch { return false; }
}

/** Ejecuta por SSH (token elevado en Windows para admins). Requiere vms.<vm>.sshPort y sshKey. */
export function runSSH(vm, command, { timeoutMs = 120000 } = {}) {
  const c = creds(vm);
  if (!c.sshPort || !c.sshKey) throw new Error(`La VM "${vm}" no tiene sshPort/sshKey en config.json`);
  return new Promise((resolve, reject) => {
    execFile('ssh', ['-i', c.sshKey, '-p', String(c.sshPort), '-o', 'StrictHostKeyChecking=accept-new', '-o', `UserKnownHostsFile=${path.join(path.dirname(c.sshKey), 'known_hosts')}`,
      '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', `${c.user}@localhost`, command],
      { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => err && !stdout ? reject(new Error(stderr || err.message)) : resolve((stdout + (stderr ? '\n' + stderr : '')).trim()));
  });
}

export { VBoxError };
