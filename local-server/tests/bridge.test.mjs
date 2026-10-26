// Prueba del puente (lan-sync-bridge.js) contra el servidor REAL.
// Cada "página" (PC o celular) corre en su propio contexto aislado de Node, con su propio
// localStorage y su propia ubicación, como si fueran dos navegadores distintos.
// Ejecutar:  NODE_TLS_REJECT_UNAUTHORIZED=0 node --test tests/bridge.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir, networkInterfaces } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const BRIDGE = readFileSync(join(root, '..', 'abarrotes-app', 'public', 'lan-sync-bridge.js'), 'utf8');
const CH = 'abarrotes_lan_sync';

const LAN = Object.values(networkInterfaces()).flat().find((i) => i.family === 'IPv4' && !i.internal)?.address;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000, what = 'condición') {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('tiempo agotado esperando: ' + what);
    await sleep(25);
  }
}
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

let port, dirs, proc;
async function startServer() {
  const py = process.platform === 'win32' ? 'python' : 'python3';
  proc = spawn(py, ['-m', 'lansync', '--port', String(port), '--static', dirs.web, '--cert-dir', dirs.certs, '--data-dir', dirs.data],
    { cwd: root, stdio: 'ignore' });
  await until(async () => { try { return (await fetch(`https://127.0.0.1:${port}/api/health`)).ok; } catch { return false; } }, 15000, 'servidor');
}
const stopServer = () => new Promise((res) => {
  if (!proc || proc.exitCode !== null) return res();
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {}
    res();
  } else {
    proc.once('exit', res);
    proc.kill('SIGTERM');
  }
});
const api = async (path, opt) => (await fetch(`https://127.0.0.1:${port}${path}`, opt)).json();

const allPages = [];
function makePage({ host, pathname, search = '', native = true }) {
  const store = {};
  const sb = {
    location: { host, protocol: 'https:', pathname, search, hash: '' },
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
    history: { replaceState: () => { sb.location.search = ''; } },
    WebSocket, fetch: (u, o) => fetch(new URL(u, `https://${host}`).href, o), setTimeout, clearTimeout, setInterval, clearInterval, JSON, Date, Math, console,
    Buffer, Uint8Array, AbortController,
    BroadcastChannel: native ? BroadcastChannel : undefined,
  };
  vm.createContext(sb);
  vm.runInContext(BRIDGE, sb);
  sb.__store = store;
  allPages.push(sb);
  return sb;
}
const status = (p) => p.LanSync.status;

before(async () => {
  assert.ok(LAN, 'sin IP de red local');
  const base = mkdtempSync(join(tmpdir(), 'bridge-'));
  dirs = { web: join(base, 'web'), certs: join(base, 'certs'), data: join(base, 'data') };
  mkdirSync(dirs.web);
  writeFileSync(join(dirs.web, 'index.html'), '<html>INDEX</html>');
  port = await freePort();
  await startServer();
});
after(async () => {
  for (const p of allPages) {
    try { p.LanSync.disconnect(); } catch {}
  }
  await stopServer();
  setTimeout(() => process.exit(0), 100);
});

test('PC y celular se hablan por el canal, sin eco, y los demás canales siguen siendo nativos', async () => {
  const pc = makePage({ host: `127.0.0.1:${port}`, pathname: '/pos' });
  await until(() => status(pc) === 'open', 8000, 'PC abierta');

  const { token } = await api('/api/pairing');
  const phone = makePage({ host: `${LAN}:${port}`, pathname: '/movil-prototipo.html', search: `?t=${token}` });
  await until(() => status(phone) === 'open', 8000, 'celular abierto');
  assert.equal(phone.location.search, '', 'el código debe quitarse de la barra de direcciones');
  assert.equal(phone.__store.lansync_token, token, 'el código queda guardado para reconectar');
  await until(() => pc.LanSync.phones === 1 && phone.LanSync.pc === true, 4000, 'presencia');

  const pcGot = [], phGot = [];
  const pcCh = new pc.BroadcastChannel(CH); pcCh.onmessage = (e) => pcGot.push(e.data);
  const phCh = new phone.BroadcastChannel(CH); phCh.onmessage = (e) => phGot.push(e.data);

  const scan = { type: 'BARCODE_SCANNED', barcode: '7501020515350', timestamp: '2026-10-24T10:00:00Z' };
  phCh.postMessage(scan);
  await until(() => pcGot.length === 1, 4000, 'mensaje celular->PC');
  assert.deepEqual(pcGot[0], scan);

  const ocr = { type: 'OCR_TICKET_PARSED', folio: 'OCR-1', lines: [{ sku: 'A', qty: 2 }], rawText: 'ñ'.repeat(20000) };
  pcCh.postMessage(ocr);
  await until(() => phGot.length === 1, 4000, 'mensaje PC->celular');
  assert.deepEqual(phGot[0], ocr);

  await sleep(300);
  assert.equal(pcGot.length, 1, 'la PC no debe recibir su propio mensaje');
  assert.equal(phGot.length, 1, 'el celular no debe recibir su propio mensaje');

  const other = new pc.BroadcastChannel('otro-canal');
  assert.ok(other instanceof BroadcastChannel, 'los demás canales usan el BroadcastChannel nativo');
  other.close();
  pcCh.close(); phCh.close();
  pc.LanSync.disconnect(); phone.LanSync.disconnect();
});

test('sin servidor (p. ej. ng serve) todo sigue funcionando con BroadcastChannel nativo', async () => {
  const page = makePage({ host: '127.0.0.1:9', pathname: '/pos' });
  await until(() => status(page) === 'unavailable', 6000, 'unavailable');
  const got = [];
  const a = new page.BroadcastChannel(CH), b = new page.BroadcastChannel(CH);
  b.onmessage = (e) => got.push(e.data);
  a.postMessage({ hola: 1 });
  await until(() => got.length === 1, 3000, 'entrega nativa');
  assert.deepEqual(got[0], { hola: 1 });
  a.close(); b.close();
});

test('código falso: queda "unauthorized" y no reintenta en bucle', async () => {
  const phone = makePage({ host: `${LAN}:${port}`, pathname: '/movil-prototipo.html', search: '?t=falsisimo' });
  await until(() => status(phone) === 'unauthorized', 6000, 'unauthorized');
  await sleep(2500);
  assert.equal(status(phone), 'unauthorized');
  const st = await api('/api/status');
  assert.equal(st.phones, 0);
});

test('celular sin código (abrió la página sin el QR) también queda "unauthorized"', async () => {
  const phone = makePage({ host: `${LAN}:${port}`, pathname: '/movil-prototipo.html' });
  await until(() => status(phone) === 'unauthorized', 9000, 'unauthorized por tiempo');
});

test('rotar el código expulsa al celular', async () => {
  const { token } = await api('/api/pairing');
  const phone = makePage({ host: `${LAN}:${port}`, pathname: '/movil-prototipo.html', search: `?t=${token}` });
  await until(() => status(phone) === 'open', 8000, 'abierto');
  const nuevo = await api('/api/pairing/rotate', { method: 'POST' });
  assert.notEqual(nuevo.token, token);
  await until(() => status(phone) === 'unauthorized', 6000, 'expulsado');
});

test('si el servidor se reinicia, PC y celular se reconectan solos (el código sobrevive)', async () => {
  const { token } = await api('/api/pairing');
  const pc = makePage({ host: `127.0.0.1:${port}`, pathname: '/pos' });
  const phone = makePage({ host: `${LAN}:${port}`, pathname: '/movil-prototipo.html', search: `?t=${token}` });
  await until(() => status(pc) === 'open' && status(phone) === 'open', 8000, 'abiertos');

  await stopServer();
  await until(() => status(pc) !== 'open' && status(phone) !== 'open', 6000, 'caída detectada');
  await startServer();
  await until(() => status(pc) === 'open' && status(phone) === 'open', 20000, 'reconexión');
  await until(() => pc.LanSync.phones === 1, 4000, 'presencia tras reconectar');

  const got = [];
  const a = new pc.BroadcastChannel(CH); a.onmessage = (e) => got.push(e.data);
  const b = new phone.BroadcastChannel(CH);
  b.postMessage({ despues: 'del reinicio' });
  await until(() => got.length === 1, 4000, 'mensaje tras reconectar');
  pc.LanSync.disconnect(); phone.LanSync.disconnect();
});

test('LanSync.uploadEvidence sube evidencia válida con token y devuelve id', async () => {
  const { token } = await api('/api/pairing');
  const phone = makePage({ host: `${LAN}:${port}`, pathname: '/movil-prototipo.html', search: `?t=${token}` });
  await until(() => status(phone) === 'open', 8000, 'celular abierto');

  const dummyJpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 0x12)]);
  const res = await phone.LanSync.uploadEvidence(dummyJpeg);
  assert.ok(res && res.id && res.id.length === 32, 'debe devolver objeto con id hex de 32 chars');
  assert.equal(res.bytes, dummyJpeg.length);

  phone.LanSync.disconnect();
});

test('LanSync.uploadEvidence rechaza si status es unavailable', async () => {
  const phone = makePage({ host: `127.0.0.1:${port + 99}`, pathname: '/movil-prototipo.html' });
  await until(() => status(phone) === 'unavailable', 8000, 'unavailable');

  const dummyJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]);
  await assert.rejects(
    async () => {
      await phone.LanSync.uploadEvidence(dummyJpeg);
    },
    /Servidor local no disponible/
  );
  phone.LanSync.disconnect();
});

test('localhost sin servidor: pasa a unavailable y no entra en bucle cerrado', async () => {
  const page = makePage({ host: 'localhost:54321', pathname: '/pos' });
  await until(() => status(page) === 'unavailable', 6000, 'localhost sin servidor pasa a unavailable');
  await sleep(3500);
  assert.equal(status(page), 'unavailable', 'permanece en unavailable');
  page.LanSync.disconnect();
});

test('servidor que aparece tarde: celular en LAN queda en closed y conecta al iniciar el servidor', async () => {
  const { token } = await api('/api/pairing');
  await stopServer();

  const phone = makePage({ host: `${LAN}:${port}`, pathname: '/movil-prototipo.html', search: `?t=${token}` });
  await until(() => status(phone) === 'closed', 6000, 'celular queda en closed sin servidor');
  assert.equal(status(phone), 'closed');

  await startServer();
  await until(() => status(phone) === 'open', 15000, 'celular conecta cuando servidor aparece tarde');
  phone.LanSync.disconnect();
});

test('servidor que cae y vuelve: pasa a closed y luego reconecta a open', async () => {
  const { token } = await api('/api/pairing');
  const phone = makePage({ host: `${LAN}:${port}`, pathname: '/movil-prototipo.html', search: `?t=${token}` });
  await until(() => status(phone) === 'open', 8000, 'celular abierto');

  await stopServer();
  await until(() => status(phone) === 'closed', 6000, 'caída detectada como closed');
  assert.equal(status(phone), 'closed');

  await startServer();
  await until(() => status(phone) === 'open', 15000, 'reconectado a open');
  phone.LanSync.disconnect();
});

