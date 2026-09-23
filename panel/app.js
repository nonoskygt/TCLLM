/* TCLLM panel: SPA sin dependencias. Habla con /api (Bearer) y /ws (eventos, logs, estado). */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let KEY = localStorage.getItem('tcllm.apiKey') || '';
let status = null, currentVm = null, liveTimer = null, ws = null, logs = [];

function toast(msg, err = false) { const t = $('#toast'); t.textContent = msg; t.className = err ? 'err' : ''; clearTimeout(t._t); t._t = setTimeout(() => t.className = 'hidden', 4000); }
async function api(path, opts = {}) {
  const r = await fetch('/api' + path, { ...opts, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY, ...(opts.headers || {}) }, body: opts.body && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body });
  if (r.status === 401) { showLogin('API key inválida'); throw new Error('401'); }
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') ? await r.json() : await r.blob();
  if (!r.ok) throw new Error(data.error || r.statusText);
  return data;
}
const post = (path, body = {}) => api(path, { method: 'POST', body });
const fmtMs = (ms) => { const s = Math.floor(ms / 1000); if (s < 60) return s + 's'; const m = Math.floor(s / 60); if (m < 60) return m + 'm'; const h = Math.floor(m / 60); return h + 'h ' + (m % 60) + 'm'; };
const ago = (iso) => iso ? fmtMs(Date.now() - new Date(iso.replace(/\.\d+$/, '')).getTime()) : '';

// ---------- login ----------
function showLogin(err = '') { $('#login').classList.remove('hidden'); $('#login-err').textContent = err; $('#login-key').focus(); }
$('#login-btn').onclick = async () => { KEY = $('#login-key').value.trim(); localStorage.setItem('tcllm.apiKey', KEY); try { await api('/health'); $('#login').classList.add('hidden'); boot(); } catch (e) { showLogin('API key inválida'); } };
$('#login-key').onkeydown = (e) => { if (e.key === 'Enter') $('#login-btn').click(); };

// ---------- navegación ----------
const pageLoaders = {};
function go(page) {
  $$('nav a').forEach(a => a.classList.toggle('active', a.dataset.page === page));
  $$('.page').forEach(p => p.classList.toggle('hidden', p.id !== 'page-' + page));
  location.hash = page;
  if (page !== 'vms') stopLive();
  pageLoaders[page]?.();
}
$$('nav a').forEach(a => a.onclick = () => go(a.dataset.page));

// ---------- estado global / pills ----------
function renderPills(s) {
  if (!s) return;
  const p = (name, ok, extra = '') => `<span class="pill ${ok === true ? 'ok' : ok === false ? 'down' : 'warn'}">${name}${extra}</span>`;
  $('#pills').innerHTML = p('TCLLM', true, ' ' + fmtMs(s.tcllm.uptimeMs)) + p('VirtualBox', s.virtualbox.ok) + p('Playwright', s.playwright.listening && s.playwright.mcpOk ? true : s.playwright.running ? null : false) + p('Bridge', s.bridge.alive) + p('MCP ' + (s.mcpSessions ?? 0) + ' ses.', true);
  $('#ver').textContent = 'v' + s.tcllm.version + ' · ' + s.tcllm.host + ':' + s.tcllm.port;
}

// ---------- dashboard ----------
pageLoaders.dashboard = async () => {
  const s = status || await refreshStatus();
  const h = s.host || {};
  $('#dash-cards').innerHTML = `
    <div class="card"><h4>Host ${esc(h.hostname || '')}</h4><div class="big">CPU ${h.cpuPercent ?? '?'}%</div><div class="muted">RAM libre ${h.ramFreeMB ?? '?'} / ${h.ramTotalMB ?? '?'} MB · ${(h.disks || []).map(d => `${d.drive} ${d.freeGB} GB libres`).join(' · ')}</div><div class="muted">${h.hypervisorPresent ? 'Hyper-V activo (VirtualBox en modo NEM: lento, reinicios vigilados)' : 'Sin Hyper-V'}</div></div>
    <div class="card"><h4>VirtualBox</h4><div class="big">${s.virtualbox.ok ? esc(s.virtualbox.version) : 'no disponible'}</div><div class="muted">${s.vms.length} VMs · ${s.vms.filter(v => v.state === 'running').length} en ejecución</div></div>
    <div class="card"><h4>Playwright MCP (navegador)</h4><div class="big">${s.playwright.listening ? 'activo' : s.playwright.enabled ? 'arrancando' : 'deshabilitado'}</div><div class="muted">${esc(s.playwright.url || '')} · ${s.playwright.toolCount ?? '?'} tools · ${s.playwright.windows?.length ?? 0} ventanas · reinicios ${s.playwright.restarts ?? 0}</div></div>
    <div class="card"><h4>TCLLM</h4><div class="big">v${esc(s.tcllm.version)}</div><div class="muted">pid ${s.tcllm.pid} · ${fmtMs(s.tcllm.uptimeMs)} · ${s.tcllm.rssMB} MB · Node ${esc(s.tcllm.node)} · ${s.mcpSessions ?? 0} sesiones MCP</div></div>`;
  $('#dash-vms').innerHTML = s.vms.map(v => `<div class="card"><div class="row between"><h4>${esc(v.name)}</h4><span class="tag ${v.state}">${v.state}</span></div>
    ${v.state === 'running' ? `<img src="/api/vms/${encodeURIComponent(v.name)}/screenshot.png?api_key=${encodeURIComponent(KEY)}&t=${Date.now()}" onerror="this.style.display='none'">` : ''}
    <div class="muted">${esc(v.os || '')} · ${v.memoryMB} MB · ${v.cpus} CPU ${v.controllable ? '· controlable' : ''} ${v.ssh === true ? '· ssh ok' : ''}</div>
    <div class="row wrap" style="margin-top:8px">${v.state === 'running' ? `<button onclick="vmAct('${esc(v.name)}','stop')">Apagar</button><button onclick="vmAct('${esc(v.name)}','restart')">Reiniciar</button>` : `<button class="primary" onclick="vmAct('${esc(v.name)}','start')">Encender</button>`}<button onclick="openVm('${esc(v.name)}')">Abrir</button></div></div>`).join('') || '<div class="muted">No hay VMs registradas en VirtualBox.</div>';
  renderEvents('#dash-events', await api('/events?limit=15'));
};
function renderEvents(sel, events) { $(sel).innerHTML = (events || []).slice().reverse().map(e => `<div class="item"><span class="tag">${esc(e.ts.slice(11, 19))}</span><span class="t">${esc(e.type)} ${esc(e.target || e.vm || '')} ${e.from ? esc(e.from) + ' → ' + esc(e.to) : ''} ${e.resets ? 'reset #' + e.resets : ''}</span></div>`).join('') || '<div class="muted">sin eventos</div>'; }

async function refreshStatus() { status = await api('/status'); renderPills(status); return status; }

// ---------- VMs ----------
window.vmAct = async (name, act, body = {}) => {
  const labels = { start: 'Encendiendo (puede tardar minutos)…', stop: 'Apagando…', restart: 'Reiniciando (vigilado)…', reset: 'Reset…', show: 'Mostrando ventana…', hide: 'Ocultando…', save_state: 'Guardando estado…' };
  toast(labels[act] || act);
  try { const r = await post(`/vms/${encodeURIComponent(name)}/${act}`, body); toast(`${name}: ${r.action || r.state || 'ok'}${r.resets ? ' (resets ' + r.resets + ')' : ''}`); }
  catch (e) { toast(e.message, true); }
  refreshStatus().then(() => { pageLoaders.dashboard(); if (currentVm === name) loadVmDetail(); });
};
pageLoaders.vms = async () => {
  const vms = await api('/vms');
  $('#vm-list').innerHTML = vms.map(v => `<div class="card"><div class="row between"><h4>${esc(v.name)}</h4><span class="tag ${v.state}">${v.state}</span></div>
    <div class="muted">${esc(v.os || '')} · ${v.memoryMB} MB · ${v.cpus} CPU · GA ${esc(v.guestAdditions || '-')} ${v.controllable ? '' : '· <b>sin credenciales</b>'}</div>
    <div class="row wrap" style="margin-top:8px">
      ${v.state === 'running' ? `<button onclick="vmAct('${esc(v.name)}','stop')">Apagar</button><button onclick="vmAct('${esc(v.name)}','restart')">Reiniciar</button><button onclick="vmAct('${esc(v.name)}','reset')" class="warn">Reset</button><button onclick="vmAct('${esc(v.name)}','show')">Mostrar</button><button onclick="vmAct('${esc(v.name)}','hide')">Ocultar</button>` : `<button class="primary" onclick="vmAct('${esc(v.name)}','start')">Encender</button>${v.state === 'saved' ? `<button onclick="vmAct('${esc(v.name)}','stop',{force:true})" class="warn">Descartar estado</button>` : ''}`}
      <button onclick="openVm('${esc(v.name)}')">Controlar</button></div></div>`).join('');
  if (currentVm) loadVmDetail();
};
window.openVm = (name) => { currentVm = name; go('vms'); $('#vm-detail').classList.remove('hidden'); loadVmDetail(); };
async function loadVmDetail() {
  if (!currentVm) return;
  const v = await api(`/vms/${encodeURIComponent(currentVm)}`);
  $('#vm-title').textContent = `${v.name} — ${v.state}`;
  $('#vm-actions').innerHTML = v.state === 'running'
    ? `<button onclick="vmAct('${esc(v.name)}','stop')">Apagar</button><button onclick="vmAct('${esc(v.name)}','restart')">Reiniciar seguro</button><button onclick="vmAct('${esc(v.name)}','reset')" class="warn">Reset</button><button onclick="vmAct('${esc(v.name)}','show')">Mostrar ventana</button><button onclick="vmAct('${esc(v.name)}','hide')">Ocultar ventana</button>`
    : `<button class="primary" onclick="vmAct('${esc(v.name)}','start')">Encender</button>`;
  $('#vm-info').textContent = JSON.stringify(v, null, 2);
  $('#vm-snaps').innerHTML = (v.snapshots || []).map(s => `<div class="item"><span class="t">${esc(s.name)} ${s.current ? '<span class="tag ok">actual</span>' : ''}</span><button onclick="snapAct('restore','${esc(s.name)}')" ${v.state === 'running' ? 'disabled title="apaga la VM primero"' : ''}>Restaurar</button><button class="danger" onclick="snapAct('delete','${esc(s.name)}')">Borrar</button></div>`).join('') || '<div class="muted">sin snapshots</div>';
  if (v.state === 'running') startLive(); else { stopLive(); $('#vm-screen').removeAttribute('src'); }
}
window.snapAct = async (act, name) => { if (act === 'delete' && !confirm(`¿Borrar snapshot "${name}"?`)) return; if (act === 'restore' && !confirm(`¿Restaurar "${name}"? Se pierde el estado actual.`)) return; try { const r = act === 'restore' ? await post(`/vms/${encodeURIComponent(currentVm)}/snapshots/${encodeURIComponent(name)}/restore`) : await api(`/vms/${encodeURIComponent(currentVm)}/snapshots/${encodeURIComponent(name)}`, { method: 'DELETE' }); toast(r.action); loadVmDetail(); } catch (e) { toast(e.message, true); } };
$('#vm-snap-take').onclick = async () => { const n = $('#vm-snap-name').value.trim(); if (!n) return; try { await post(`/vms/${encodeURIComponent(currentVm)}/snapshots`, { name: n }); toast('snapshot creado'); loadVmDetail(); } catch (e) { toast(e.message, true); } };

let screenSize = { w: 1024, h: 768 };
async function shot() {
  if (!currentVm) return;
  const img = $('#vm-screen');
  const url = `/api/vms/${encodeURIComponent(currentVm)}/screenshot.png?api_key=${encodeURIComponent(KEY)}&t=${Date.now()}`;
  await new Promise((res) => { const i = new Image(); i.onload = () => { screenSize = { w: i.naturalWidth, h: i.naturalHeight }; img.src = i.src; res(); }; i.onerror = res; i.src = url; });
}
function startLive() { stopLive(); shot(); if ($('#vm-live').checked) liveTimer = setInterval(() => { if (document.hidden) return; shot(); }, 2000); }
function stopLive() { clearInterval(liveTimer); liveTimer = null; }
$('#vm-live').onchange = () => $('#vm-live').checked ? startLive() : stopLive();
$('#vm-shot').onclick = shot;
$('#vm-screen').onmousemove = (e) => { const r = e.target.getBoundingClientRect(); $('#vm-coords').textContent = `${Math.round(e.offsetX * screenSize.w / r.width)}, ${Math.round(e.offsetY * screenSize.h / r.height)}`; };
$('#vm-screen').onclick = async (e) => {
  const r = e.target.getBoundingClientRect(); const x = Math.round(e.offsetX * screenSize.w / r.width), y = Math.round(e.offsetY * screenSize.h / r.height);
  try { await post(`/vms/${encodeURIComponent(currentVm)}/click`, { x, y, button: $('#vm-btn').value, count: $('#vm-dbl').checked ? 2 : 1 }); setTimeout(shot, 600); } catch (err) { toast(err.message, true); }
};
$('#vm-screen').oncontextmenu = (e) => { e.preventDefault(); const r = e.target.getBoundingClientRect(); post(`/vms/${encodeURIComponent(currentVm)}/click`, { x: Math.round(e.offsetX * screenSize.w / r.width), y: Math.round(e.offsetY * screenSize.h / r.height), button: 'right' }).then(() => setTimeout(shot, 600)).catch(err => toast(err.message, true)); };
$('#vm-screen').onwheel = (e) => { e.preventDefault(); const r = e.target.getBoundingClientRect(); post(`/vms/${encodeURIComponent(currentVm)}/scroll`, { x: Math.round(e.offsetX * screenSize.w / r.width), y: Math.round(e.offsetY * screenSize.h / r.height), amount: Math.sign(e.deltaY) * 3 }).catch(() => {}); };
$$('.keys button').forEach(b => b.onclick = () => post(`/vms/${encodeURIComponent(currentVm)}/key`, { keys: b.dataset.key }).then(() => setTimeout(shot, 500)).catch(e => toast(e.message, true)));
$('#vm-keys-send').onclick = () => post(`/vms/${encodeURIComponent(currentVm)}/key`, { keys: $('#vm-keys').value }).then(() => setTimeout(shot, 500)).catch(e => toast(e.message, true));
$('#vm-type').onclick = () => post(`/vms/${encodeURIComponent(currentVm)}/type`, { text: $('#vm-text').value }).then(() => setTimeout(shot, 500)).catch(e => toast(e.message, true));
$('#vm-paste').onclick = () => post(`/vms/${encodeURIComponent(currentVm)}/paste`, { text: $('#vm-text').value }).then(() => setTimeout(shot, 800)).catch(e => toast(e.message, true));
$('#vm-run').onclick = async () => { $('#vm-out').textContent = '…'; try { const r = await post(`/vms/${encodeURIComponent(currentVm)}/run`, { command: $('#vm-cmd').value, admin: $('#vm-admin').checked }); $('#vm-out').textContent = r.output || '(sin salida)'; } catch (e) { $('#vm-out').textContent = 'Error: ' + e.message; } };

// ---------- navegador ----------
pageLoaders.browser = async () => {
  const b = await api('/browser');
  $('#browser-cards').innerHTML = `<div class="card"><h4>Estado</h4><div class="big">${b.listening ? (b.mcpOk ? 'activo' : 'escuchando') : b.enabled ? 'arrancando…' : 'deshabilitado'}</div><div class="muted">pid ${b.pid || '-'} · ${fmtMs(b.uptimeMs)} · reinicios ${b.restarts}</div></div>
    <div class="card"><h4>Endpoint MCP (directo)</h4><div class="big" style="font-size:14px">${esc(b.url)}</div><div class="muted">navegador ${esc(b.browser)} · ${b.sessions === 'persistent' ? 'sesiones persistentes (perfil en disco, contexto compartido)' : 'aislado (contexto por cliente, sin persistencia)'} · ${b.toolCount ?? '?'} tools</div></div>
    <div class="card"><h4>Ventanas</h4>${(b.windows || []).map(w => `<div class="row between"><span class="t">${esc(w.title)}</span><span class="tag ${w.visible ? 'ok' : ''}">${w.visible ? 'visible' : 'oculta'}</span></div>`).join('') || '<div class="muted">sin ventanas (se abren al navegar)</div>'}</div>`;
  await renderSessions();
  await renderCalls();
  await renderBrowsers();
  const tools = await api('/browser/tools');
  $('#br-tools').innerHTML = tools.map(t => `<div class="item"><span class="t"><b>${esc(t.name)}</b> · ${esc(t.description)}</span></div>`).join('');
};
async function renderCalls() {
  try {
    const c = await api('/calls?browser=1&limit=15');
    const secs = (ms) => (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + ' s';
    const whoOf = (x) => `${esc(x.via)}:${esc(x.client)}${x.proc ? ` <span class="muted">[${esc(x.proc)}]</span>` : ''}`;
    const tag = (o) => `<span class="tag ${o === 'ok' ? 'ok' : o === 'en curso' ? 'warn' : 'down'}">${esc(o)}</span>`;
    const row = (x) => `<div class="row between"><span class="t mono">${esc(x.startedAt.slice(11, 19))} · ${esc(x.tool)} · ${whoOf(x)}</span><span>${secs(x.ms)} ${tag(x.outcome)}</span></div>`;
    $('#calls-box').innerHTML = `
      <div class="card"><h4>En curso</h4>${c.inFlight.length ? c.inFlight.map(row).join('') : '<div class="muted">ninguna</div>'}</div>
      <div class="card" style="margin-top:8px"><h4>Últimas</h4>${c.recent.length ? c.recent.map(row).join('') : '<div class="muted">todavía no hubo llamadas al navegador por TCLLM</div>'}</div>`;
    $('#calls-msg').textContent = c.inFlight.some(x => x.ms > 30000) ? 'hay una llamada de más de 30 s en curso: puede estar trabando el navegador' : '';
  } catch (e) { $('#calls-box').textContent = e.message; }
}
$('#calls-refresh').onclick = renderCalls;

async function renderSessions() {
  try {
    const s = await api('/sessions');
    const dom = s.shared.domains || [];
    $('#sess-box').innerHTML = `<div class="row wrap" style="gap:10px;align-items:center">
        <span class="tag ${s.persistent ? 'ok' : 'warn'}">${s.persistent ? 'persistente' : 'aislado'}</span>
        <span>Bolsa común: <b>${s.shared.cookies}</b> cookies · ${dom.length} dominios</span>
        <span class="muted">${esc(dom.slice(0, 6).join(', '))}${dom.length > 6 ? ` +${dom.length - 6}` : ''}</span>
      </div>
      <div class="muted" style="margin-top:6px">Perfiles: ${s.profiles.length ? s.profiles.map(p => `${esc(p.title)} (${p.sizeMB} MB)`).join(' · ') : 'ninguno todavía'}</div>`;
    $('#sess-save').disabled = !s.persistent;
  } catch (e) { $('#sess-box').textContent = e.message; }
}
$('#sess-save').onclick = async () => {
  if (!confirm('Guardar los logins del navegador activo en la bolsa común.\n\nReinicia el navegador: se pierden las pestañas abiertas. ¿Seguir?')) return;
  toast('Guardando sesiones… (reinicia el navegador)');
  try { const r = await post('/sessions/save'); toast(r.saved ? `Guardadas ${r.cookies} cookies` : (r.note || r.error || 'nada que guardar'), !r.saved); pageLoaders.browser(); }
  catch (e) { toast(e.message, true); }
};

async function renderBrowsers() {
  const d = await api('/browser/browsers');
  $('#br-browsers').innerHTML = d.browsers.map(b => {
    const active = b.id === d.active;
    const st = installing[b.id];
    return `<div class="card"><div class="row between"><h4>${esc(b.title)}</h4><span class="tag ${active ? 'ok' : b.installed ? '' : 'warn'}">${active ? 'activo' : b.installed ? 'instalado' : 'no instalado'}</span></div>
      <div class="muted">${esc(b.path || (b.installable ? 'build de Playwright ' + (b.revision || '') : 'no encontrado en el sistema'))}${b.note ? '<br>' + esc(b.note) : ''}${st ? '<br><b>' + esc(st) + '</b>' : ''}</div>
      <div class="row wrap" style="margin-top:8px">${b.installed && !active ? `<button class="primary" onclick="useBrowser('${esc(b.id)}')" ${switching ? 'disabled' : ''}>Usar</button>` : ''}${!b.installed && b.installable && !st ? `<button onclick="installBrowser('${esc(b.id)}')">Instalar</button>` : ''}</div></div>`;
  }).join('');
}
const installing = {}; let switching = false;
window.useBrowser = async (id) => { if (switching) return; switching = true; toast('Cambiando a ' + id + '… (hasta 30 s)'); renderBrowsers(); try { const r = await post('/browser/use', { browser: id }); toast(r.applied === false ? r.note : 'Navegador: ' + id, r.applied === false); } catch (e) { toast(e.message, true); } switching = false; pageLoaders.browser(); };
window.installBrowser = async (id) => {
  installing[id] = 'descargando…'; renderBrowsers();
  try { await post('/browser/install', { browser: id }); } catch (e) { installing[id] = 'error: ' + e.message; renderBrowsers(); return; }
  let failures = 0;
  const poll = setInterval(async () => {
    try {
      const s = await api('/browser/install/' + id); failures = 0;
      if (s.status === 'running') { installing[id] = 'descargando… ' + (s.log?.slice(-1)[0] || ''); renderBrowsers(); }
      else { clearInterval(poll); delete installing[id]; toast(s.status === 'done' ? id + ' instalado' : 'error: ' + (s.error || s.status), s.status !== 'done'); renderBrowsers(); }
    } catch { if (++failures >= 5) { clearInterval(poll); delete installing[id]; toast('sin respuesta del servidor durante la instalación', true); renderBrowsers(); } }
  }, 2000);
};
$$('[data-act]').forEach(b => b.onclick = async () => { const a = b.dataset.act; toast('…'); try { const r = a === 'browser-restart' ? await post('/browser/restart') : await post(a === 'browser-show' ? '/browser/show' : '/browser/hide'); toast(JSON.stringify(r).slice(0, 120)); pageLoaders.browser(); } catch (e) { toast(e.message, true); } });
$('#br-go').onclick = async () => { $('#br-out').textContent = '…'; try { const r = await post('/browser/tools/navigate', { url: $('#br-url').value }); $('#br-out').textContent = (r.upstream?.content || []).map(c => c.text || '[' + c.type + ']').join('\n'); pageLoaders.browser(); } catch (e) { $('#br-out').textContent = e.message; } };
$('#br-snap').onclick = async () => { $('#br-out').textContent = '…'; try { const r = await post('/browser/tools/snapshot', {}); $('#br-out').textContent = (r.upstream?.content || []).map(c => c.text || '').join('\n'); } catch (e) { $('#br-out').textContent = e.message; } };
$('#br-shot').onclick = async () => { try { const r = await post('/browser/tools/take_screenshot', { type: 'png' }); const img = (r.upstream?.content || []).find(c => c.type === 'image'); if (img) { $('#br-img').src = `data:${img.mimeType};base64,${img.data}`; $('#br-img').classList.remove('hidden'); } else $('#br-out').textContent = (r.upstream?.content || []).map(c => c.text || '').join('\n'); } catch (e) { $('#br-out').textContent = e.message; } };

// ---------- ventanas ----------
pageLoaders.windows = async () => {
  const ws = await api('/windows');
  const kinds = { vm: 'VM', browser: 'Navegador TCLLM', 'browser-other': 'Otro navegador Playwright', 'vbox-manager': 'VirtualBox Manager' };
  $('#win-list').innerHTML = ws.map(w => `<div class="item"><span class="tag">${kinds[w.kind] || w.kind}</span><span class="t">${esc(w.title)} <span class="muted">(${esc(w.process)} pid ${w.pid})</span></span><span class="tag ${w.visible ? 'ok' : ''}">${w.visible ? 'visible' : 'oculta'}</span><button onclick="winAct('${w.hwnd}','${w.visible ? 'hide' : 'show'}')">${w.visible ? 'Ocultar' : 'Mostrar'}</button></div>`).join('') || '<div class="muted">No hay ventanas de VMs ni del navegador.</div>';
};
window.winAct = async (hwnd, act) => { try { await post(`/windows/${hwnd}/${act}`); pageLoaders.windows(); } catch (e) { toast(e.message, true); } };
$('#win-refresh').onclick = pageLoaders.windows;

// ---------- servicios ----------
pageLoaders.services = async () => {
  const s = await refreshStatus();
  const card = (title, ok, body, actions = '') => `<div class="card"><div class="row between"><h4>${title}</h4><span class="tag ${ok === true ? 'ok' : ok === false ? 'warn' : ''}">${ok === true ? 'OK' : ok === false ? 'DOWN' : '?'}</span></div><div class="muted">${body}</div>${actions ? `<div class="row" style="margin-top:8px">${actions}</div>` : ''}</div>`;
  $('#svc-cards').innerHTML = card('TCLLM', true, `v${esc(s.tcllm.version)} · pid ${s.tcllm.pid} · ${fmtMs(s.tcllm.uptimeMs)} · ${s.tcllm.rssMB} MB`)
    + card('VirtualBox', s.virtualbox.ok, esc(s.virtualbox.version || s.virtualbox.error || ''))
    + card('Playwright MCP', s.playwright.listening && s.playwright.mcpOk, `${esc(s.playwright.url || '')} · pid ${s.playwright.pid || '-'} · ${fmtMs(s.playwright.uptimeMs || 0)} · reinicios ${s.playwright.restarts ?? 0}`, `<button onclick="svcRestart('playwright')">Reiniciar</button>`)
    + card('Bridge PowerShell', s.bridge.alive, `pid ${s.bridge.pid || '-'}`, `<button onclick="svcRestart('bridge')">Reiniciar</button>`)
    + s.vms.map(v => card('VM ' + esc(v.name), v.state === 'running' ? true : v.state === 'poweroff' ? null : false, `${v.state} · GA nivel ${v.guestRunLevel ?? '-'} ${v.ssh === true ? '· ssh ok' : v.ssh === false ? '· ssh sin respuesta' : ''} · desde ${esc((v.since || '').slice(0, 19))}`)).join('')
    + card('Host', (s.host.cpuPercent ?? 100) < 90, `CPU ${s.host.cpuPercent}% · RAM libre ${s.host.ramFreeMB} MB · ${(s.host.disks || []).map(d => d.drive + ' ' + d.freeGB + 'GB').join(' ')}`);
  renderEvents('#svc-events', await api('/events?limit=100'));
};
window.svcRestart = async (n) => { toast('Reiniciando ' + n + '…'); try { await post(`/services/${n}/restart`); toast(n + ' reiniciado'); setTimeout(pageLoaders.services, 1500); } catch (e) { toast(e.message, true); } };

// ---------- conectar ----------
pageLoaders.connect = async () => {
  const [agents, sn] = await Promise.all([api('/agents'), api('/agents/snippets')]);
  $('#cn-mcp').textContent = sn.url; $('#cn-api').textContent = sn.rest.openapi; $('#cn-openai').textContent = sn.rest.toolsOpenAI;
  const block = (title, text) => `<pre class="snippet">${esc(text)}</pre><button onclick="navigator.clipboard.writeText(${JSON.stringify(text).replace(/"/g, '&quot;')});toast('copiado')" style="margin-top:6px">Copiar</button>`;
  const cards = [];
  for (const a of agents) {
    const s = sn[a.id]; if (!s && a.id !== 'agents') continue;
    let body = '';
    if (a.id === 'claude') body = block('CLI', s.cli) + block('~/.claude.json', JSON.stringify(s.json, null, 2));
    else if (a.id === 'codex') body = block('config.toml', s.toml) + block('variable de entorno', s.env);
    else if (a.id === 'agents') body = '<div class="muted">SKILL.md en ~/.agents/skills/tcllm (la leen Codex, Gemini, OpenCode, Copilot…)</div>';
    else body = block(s.file, JSON.stringify(s.json, null, 2));
    cards.push(`<div class="card"><div class="row between"><h4>${esc(a.title)}</h4><span class="tag ${a.installed ? 'ok' : ''}">${a.installed ? (a.configured ? 'instalado · configurado' : 'instalado') : 'no detectado'}</span></div><div class="muted">${esc(a.config || a.skills || '')}</div>${body}<div class="row" style="margin-top:6px"><button onclick="installAgent('${a.id}')">Configurar este agente</button></div></div>`);
  }
  cards.push(`<div class="card"><h4>Cualquier LLM (REST)</h4>${block('curl', sn.rest.example)}<div class="muted">OpenAPI: ${esc(sn.rest.openapi)}<br>Tools OpenAI: ${esc(sn.rest.toolsOpenAI)}</div></div>`);
  cards.push(`<div class="card"><h4>MCP por stdio</h4>${block('stdio', sn.stdio.command + ' ' + sn.stdio.args.join(' '))}<div class="muted">${esc(sn.stdio.note)}</div></div>`);
  $('#cn-agents').innerHTML = cards.join('');
};
window.installAgent = async (id) => { $('#cn-msg').textContent = 'instalando…'; try { const r = await post('/agents/install', { agents: [id] }); $('#cn-msg').textContent = r.map(x => `${x.ok ? 'OK' : 'ERR'} ${x.title}: ${x.ok ? x.files.join(', ') : x.error}`).join(' · '); pageLoaders.connect(); } catch (e) { $('#cn-msg').textContent = e.message; } };
$('#cn-install').onclick = async () => { $('#cn-msg').textContent = 'instalando…'; try { const r = await post('/agents/install', {}); $('#cn-msg').textContent = r.map(x => `${x.ok ? 'OK' : 'ERR'} ${x.title}`).join(' · '); pageLoaders.connect(); } catch (e) { $('#cn-msg').textContent = e.message; } };
$('#cn-skill').onclick = () => window.open('/api/skill.md?api_key=' + encodeURIComponent(KEY));

// ---------- conexiones / acceso ----------
let access = null;
pageLoaders.access = async () => { $('#acc-fw-state').textContent = 'leyendo firewall…'; access = await api('/access'); renderAccess(); };
function chip(text, onDel, cls = '') { return `<span class="chip ${cls}">${esc(text)}${onDel ? `<button title="quitar" onclick="${onDel}">✕</button>` : ''}</span>`; }
function renderAccess() {
  const a = access; if (!a) return;
  $('#access-cards').innerHTML = `
    <div class="card"><h4>Playwright MCP</h4><div class="big">${a.exposed ? 'en la red' : 'solo local'}</div><div class="muted">escucha ${esc(a.host)}:${a.port} · ${a.allowAnyHost ? 'acepta cualquier Host' : a.effectiveHosts.length + ' hosts permitidos'}</div></div>
    <div class="card"><h4>URLs para conectarse</h4>${a.reachableUrls.map(u => `<div class="row between"><span class="t mono">${esc(u)}</span></div>`).join('')}</div>
    <div class="card"><h4>Firewall (puerto ${a.port})</h4>${renderFwState(a.firewall)}</div>`;
  $('#acc-nets').innerHTML = (a.allowedNetworks.length ? a.allowedNetworks.map(n => chip(n, `accDelNet('${esc(n)}')`, n === 'Any' ? 'any' : '')).join('') : '<span class="muted">sin restricción por red (lo que permita el firewall actual)</span>');
  $('#acc-fw-cmd').textContent = a.firewallCommand;
  $('#acc-anyhost').checked = a.allowAnyHost;
  $('#acc-hosts').innerHTML = a.allowAnyHost
    ? '<span class="muted">acepta cualquier Host (*)</span>'
    : chip(`localhost:${a.port}`) + chip(`127.0.0.1:${a.port}`) + a.allowedHosts.map(h => chip(h, `accDelHost('${esc(h)}')`)).join('');
}
function renderFwState(fw) {
  if (!fw || fw.error) return `<div class="muted">no se pudo leer (${esc(fw?.error || '')})</div>`;
  if (!fw.rules || !fw.rules.length) return '<div class="muted">sin regla propia; el acceso depende de otras reglas del sistema</div>';
  return fw.rules.map(r => `<div class="row between"><span class="t">${esc(r.name)}</span><span class="tag ${r.enabled && r.action === 'Allow' ? 'ok' : 'down'}">${esc((r.remote || ['Any']).join(', '))}</span></div>`).join('');
}
window.accDelNet = async (n) => { const nets = access.allowedNetworks.filter(x => x !== n); await saveNets(nets); };
window.accDelHost = async (h) => { try { const r = await post('/access/hosts', { allowedHosts: access.allowedHosts.filter(x => x !== h) }); access = r; renderAccess(); toast('Host quitado; Playwright relanzado'); } catch (e) { toast(e.message, true); } };
async function saveNets(nets) { try { const r = await post('/access/networks', { networks: nets }); access.allowedNetworks = r.allowedNetworks; access.firewallCommand = r.firewallCommand; renderAccess(); $('#acc-fw-msg').textContent = 'guardado. Pulsa “Aplicar al firewall” para que tenga efecto.'; } catch (e) { toast(e.message, true); } }
$('#acc-net-add').onclick = () => { const v = $('#acc-net-in').value.trim(); if (!v) return; saveNets([...new Set([...access.allowedNetworks, v])]); $('#acc-net-in').value = ''; };
$('#acc-net-in').onkeydown = (e) => { if (e.key === 'Enter') $('#acc-net-add').click(); };
$('#acc-net-mine').onclick = () => saveNets([...new Set([...access.allowedNetworks.filter(n => n !== 'Any'), '192.168.2.0/24'])]);
$('#acc-net-any').onclick = () => saveNets(['Any']);
$('#acc-fw-apply').onclick = async () => { $('#acc-fw-msg').textContent = 'aplicando… acepta el aviso de administrador (UAC)'; try { const r = await post('/access/firewall/apply'); access = r.status; renderAccess(); $('#acc-fw-msg').textContent = 'firewall aplicado: ' + (r.remote || []).join(', '); toast('Firewall aplicado'); } catch (e) { $('#acc-fw-msg').textContent = ''; toast(e.message, true); } };
$('#acc-host-add').onclick = async () => { const v = $('#acc-host-in').value.trim(); if (!v) return; try { const r = await post('/access/hosts', { allowedHosts: [...access.allowedHosts, v] }); access = r; renderAccess(); $('#acc-host-in').value = ''; toast('Host añadido; Playwright relanzado'); } catch (e) { toast(e.message, true); } };
$('#acc-host-in').onkeydown = (e) => { if (e.key === 'Enter') $('#acc-host-add').click(); };
$('#acc-host-mine').onclick = async () => { try { const r = await post('/access/hosts/local'); access = r; renderAccess(); toast('IPs locales añadidas; Playwright relanzado'); } catch (e) { toast(e.message, true); } };
$('#acc-anyhost').onchange = async (e) => { const on = e.target.checked; if (on && !confirm('Aceptar cualquier Host desactiva la protección anti-rebinding. El acceso quedará limitado solo por el firewall. ¿Continuar?')) { e.target.checked = false; return; } toast('Aplicando… (relanza Playwright)'); try { const r = await post('/access/hosts', { allowAnyHost: on }); access = r; renderAccess(); toast('Aplicado'); } catch (err) { toast(err.message, true); } };

// ---------- logs ----------
function renderLogs() { const lvl = $('#log-level').value; const v = $('#log-view'); v.innerHTML = logs.filter(l => !lvl || l.level === lvl).slice(-800).map(l => `<span class="log-${l.level}">${esc(l.ts.slice(11, 19))} [${l.level}] ${esc(l.mod)}: ${esc(l.msg)}${l.extra ? ' ' + esc(JSON.stringify(l.extra)) : ''}</span>`).join('\n'); if ($('#log-follow').checked) v.scrollTop = v.scrollHeight; }
pageLoaders.logs = async () => { if (!logs.length) logs = await api('/logs?n=300'); renderLogs(); };
$('#log-level').onchange = renderLogs; $('#log-clear').onclick = () => { logs = []; renderLogs(); };

// ---------- ajustes ----------
pageLoaders.settings = async () => { $('#cfg-text').value = JSON.stringify(await api('/config'), null, 2); };
$('#cfg-reload').onclick = pageLoaders.settings;
$('#cfg-save').onclick = async () => { try { const r = await api('/config', { method: 'PUT', body: JSON.parse($('#cfg-text').value) }); $('#cfg-msg').textContent = 'Guardado. ' + (r.restartNeeded ? 'Reinicia TCLLM para aplicar puerto/host/Playwright.' : ''); } catch (e) { $('#cfg-msg').textContent = 'Error: ' + e.message; } };
$('#cfg-rotate').onclick = async () => { if (!confirm('¿Rotar la API key? Los agentes configurados dejarán de conectar hasta reconfigurarlos.')) return; const r = await post('/config/rotate-key'); KEY = r.apiKey; localStorage.setItem('tcllm.apiKey', KEY); $('#cfg-msg').textContent = 'Nueva API key: ' + r.apiKey; };
$('#cfg-logout').onclick = () => { localStorage.removeItem('tcllm.apiKey'); location.reload(); };

// ---------- websocket ----------
function connectWs() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?api_key=${encodeURIComponent(KEY)}`);
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.type === 'hello') { logs = d.logs || []; if (d.status) { status = d.status; renderPills(status); } }
    else if (d.type === 'log') { logs.push(d.entry); if (logs.length > 2000) logs.shift(); if (!$('#page-logs').classList.contains('hidden')) renderLogs(); }
    else if (d.type === 'status') { status = { ...d.status, mcpSessions: status?.mcpSessions }; renderPills(status); if (!$('#page-dashboard').classList.contains('hidden')) pageLoaders.dashboard(); }
    else if (d.type === 'event') { toast(`${d.event.type} ${d.event.target || d.event.vm || ''} ${d.event.from ? d.event.from + ' → ' + d.event.to : ''}`); }
  };
  ws.onclose = () => setTimeout(connectWs, 3000);
}

async function boot() {
  try { await api('/health'); } catch { return; }
  try { await refreshStatus(); } catch (e) { return; }
  connectWs();
  go(location.hash.replace('#', '') || 'dashboard');
}
if (!KEY) showLogin(); else api('/health').then(boot).catch(() => showLogin());
