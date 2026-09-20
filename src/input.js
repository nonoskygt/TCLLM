// Ratón / teclado / portapapeles hacia una VM. Coordenadas 0-based de la captura de pantalla.
import * as vbox from './vbox.js';
import { bridge } from './bridge.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const BTN = { left: 1, right: 2, middle: 4 };

const mouse = (vm, x, y, buttons = 0, dz = 0) => bridge.call('mouse', { vm, x: Math.round(x), y: Math.round(y), buttons, dz });

export async function move(vm, x, y) { await mouse(vm, x, y); return { moved: [x, y] }; }

export async function click(vm, x, y, button = 'left', count = 1) {
  const b = BTN[button] ?? BTN.left;
  await mouse(vm, x, y); await sleep(80);
  for (let i = 0; i < count; i++) { await mouse(vm, x, y, b); await sleep(70); await mouse(vm, x, y, 0); await sleep(70); }
  return { clicked: [x, y], button, count };
}

export async function drag(vm, x1, y1, x2, y2, steps = 12) {
  await mouse(vm, x1, y1); await sleep(100);
  await mouse(vm, x1, y1, 1); await sleep(150);
  for (let i = 1; i <= steps; i++) { await mouse(vm, x1 + (x2 - x1) * i / steps, y1 + (y2 - y1) * i / steps, 1); await sleep(30); }
  await mouse(vm, x2, y2, 0);
  return { dragged: [[x1, y1], [x2, y2]] };
}

export async function scroll(vm, x, y, amount) {
  await mouse(vm, x, y); await sleep(80);
  const dir = Math.sign(amount);
  for (let i = 0; i < Math.abs(amount); i++) { await mouse(vm, x, y, 0, dir); await sleep(40); }
  return { scrolled: amount };
}

export async function key(vm, combo) { await vbox.sendKeys(vm, combo); return { keys: combo }; }

/** Texto ASCII por scancodes (lento pero fiable). Para Unicode/largo usar paste(). */
export async function type(vm, text, delayMs = 60) {
  if (/[^\x20-\x7e\n]/.test(text)) return paste(vm, text);
  await vbox.typeText(vm, text, delayMs);
  return { typed: text.length };
}

/** Portapapeles del host -> Ctrl+V en el guest (requiere Guest Additions con portapapeles bidireccional). */
export async function paste(vm, text) {
  await bridge.call('clipboard', { text });
  await sleep(300);
  await vbox.sendKeys(vm, 'ctrl+v');
  return { pasted: text.length };
}
