import { DJIControl } from './dji-control.js';
import { VideoPane } from './video-pane.js';

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch((e) => log('err', `SW register failed: ${e.message}`));
}

const logEl = document.getElementById('log');
function log(kind, msg) {
  const line = document.createElement('div');
  line.className = kind;
  const ts = new Date().toLocaleTimeString();
  line.textContent = `[${ts}] ${msg}`;
  logEl.appendChild(line);
  while (logEl.childNodes.length > 200) logEl.removeChild(logEl.firstChild);
  logEl.scrollTop = logEl.scrollHeight;
}

const dji = new DJIControl();
if (!dji.isSupported()) {
  log('err', 'Web Bluetooth unavailable. Use Chrome on Android over HTTPS or http://localhost.');
}
dji.addEventListener('log', (ev) => log(ev.detail.kind, ev.detail.msg));

const pane1 = new VideoPane(document.getElementById('video1'), 1);
const pane2 = new VideoPane(document.getElementById('video2'), 2);
pane1.onLog = log;
pane2.onLog = log;

document.getElementById('url1').value = pane1.restoreLastUrl();
document.getElementById('url2').value = pane2.restoreLastUrl();

document.querySelectorAll('[data-load]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const id = btn.getAttribute('data-load');
    const url = document.getElementById(`url${id}`).value;
    const pane = id === '1' ? pane1 : pane2;
    pane.load(url);
    log('ok', `Loading pane ${id}: ${url || '(empty)'}`);
  });
});

document.getElementById('btn-scan').addEventListener('click', async () => {
  try {
    const session = await dji.scanAndPair();
    log('ok', `Paired ${session.device.name || session.device.id}`);
  } catch (e) {
    log('err', `Pair failed: ${e.message}`);
  }
});

const masterBtn = document.getElementById('btn-master');
const masterLabel = document.getElementById('master-label');
let masterRecording = false;

masterBtn.addEventListener('click', async () => {
  if (dji.pairedCameras.size === 0) {
    log('warn', 'No cameras paired. Tap "+ Pair Camera" first.');
    return;
  }
  masterRecording = !masterRecording;
  masterBtn.setAttribute('aria-pressed', String(masterRecording));
  masterLabel.textContent = masterRecording ? 'RECORDING — TAP TO STOP' : 'MASTER RECORD';
  try {
    const results = masterRecording ? await dji.startRecordAll() : await dji.stopRecordAll();
    const okCount = results.filter((r) => r.ok).length;
    log(okCount === results.length ? 'ok' : 'err',
      `${masterRecording ? 'START' : 'STOP'} fan-out: ${okCount}/${results.length} succeeded`);
    for (const r of results) {
      if (!r.ok) log('err', `  ${r.session.device.name || r.session.device.id}: ${r.err?.message || r.err}`);
    }
  } catch (e) {
    log('err', `Record fan-out error: ${e.message}`);
    masterRecording = !masterRecording;
    masterBtn.setAttribute('aria-pressed', String(masterRecording));
    masterLabel.textContent = masterRecording ? 'RECORDING — TAP TO STOP' : 'MASTER RECORD';
  }
});

const pairedListEl = document.getElementById('paired-list');
function renderPairedList() {
  pairedListEl.innerHTML = '';
  for (const session of dji.pairedCameras.values()) {
    const li = document.createElement('li');
    const left = document.createElement('div');
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = session.device.name || session.device.id;
    const meta = document.createElement('div');
    meta.className = 'meta';
    const batt = session.battery == null ? '—' : `${session.battery}%`;
    const state = session.connected ? 'Connected' : 'Disconnected';
    meta.textContent = `${state} • Battery ${batt} • ${session.recording ? '● REC' : 'idle'}`;
    left.appendChild(name);
    left.appendChild(meta);
    const btn = document.createElement('button');
    btn.textContent = 'Disconnect';
    btn.addEventListener('click', () => dji.disconnect(session.device.id));
    li.appendChild(left);
    li.appendChild(btn);
    pairedListEl.appendChild(li);
  }
}

function updateCamChips() {
  const sessions = Array.from(dji.pairedCameras.values());
  const slots = [
    { ble: 'cam1-ble', bat: 'cam1-bat', rec: 'cam1-rec' },
    { ble: 'cam2-ble', bat: 'cam2-bat', rec: 'cam2-rec' },
  ];
  slots.forEach((slot, i) => {
    const ble = document.getElementById(slot.ble);
    const bat = document.getElementById(slot.bat);
    const rec = document.getElementById(slot.rec);
    const cam = sessions[i];
    if (!cam) {
      ble.textContent = 'BLE: —'; ble.className = 'chip';
      bat.textContent = 'Batt: —'; bat.className = 'chip';
      rec.textContent = '● IDLE'; rec.className = 'chip';
      return;
    }
    ble.textContent = cam.connected ? 'BLE: ✓' : 'BLE: ✗';
    ble.className = 'chip ' + (cam.connected ? 'ok' : 'warn');
    bat.textContent = cam.battery == null ? 'Batt: —' : `Batt: ${cam.battery}%`;
    bat.className = 'chip ' + (cam.battery == null ? '' : cam.battery < 20 ? 'warn' : 'ok');
    rec.textContent = cam.recording ? '● REC' : '● IDLE';
    rec.className = 'chip ' + (cam.recording ? 'rec' : '');
  });
}

dji.addEventListener('statusChange', () => {
  renderPairedList();
  updateCamChips();
});

renderPairedList();
updateCamChips();
const REC_TEST_VARIANTS = {
  'empty-0802': { target: 0x0802, payload: [],     label: 'empty@0802' },
  'start-0802': { target: 0x0802, payload: [0x01], label: 'start@0802' },
  'stop-0802':  { target: 0x0802, payload: [0x00], label: 'stop@0802'  },
  'empty-0102': { target: 0x0102, payload: [],     label: 'empty@0102' },
  'start-0102': { target: 0x0102, payload: [0x01], label: 'start@0102' },
  'empty-0202': { target: 0x0202, payload: [],     label: 'empty@0202' },
};

document.querySelectorAll('[data-rec-test]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const key = btn.getAttribute('data-rec-test');
    const variant = REC_TEST_VARIANTS[key];
    if (!variant) return;
    try {
      await dji.testRecordFrame({
        target: variant.target,
        payload: new Uint8Array(variant.payload),
        label: variant.label,
      });
    } catch (e) {
      log('err', `Rec test ${key} error: ${e.message}`);
    }
  });
});

document.getElementById('btn-copy-log').addEventListener('click', async () => {
  const text = Array.from(logEl.childNodes).map((n) => n.textContent).join('\n');
  try {
    await navigator.clipboard.writeText(text);
    log('ok', `Copied ${text.length} chars to clipboard.`);
  } catch (e) {
    // Fallback: old-school selection + execCommand
    const range = document.createRange();
    range.selectNodeContents(logEl);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    try { document.execCommand('copy'); log('ok', 'Copied (fallback).'); }
    catch { log('err', `Copy failed: ${e.message}. Long-press the log area to select manually.`); }
    sel.removeAllRanges();
  }
});
document.getElementById('btn-clear-log').addEventListener('click', () => {
  logEl.innerHTML = '';
});

log('ok', 'Field Multi-Cam ready. Pair cameras and load streams to begin.');
log('warn', 'Protocol: node-osmo 0x55 (Action 3 compatible). Handshake test build.');
