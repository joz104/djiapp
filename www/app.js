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
function sessionStateText(session) {
  if (session.connected) return 'Connected';
  if (session.reconnecting) return `Reconnecting… (attempt ${session.reconnectAttempt})`;
  return 'Disconnected';
}

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
    meta.textContent = `${sessionStateText(session)} • Battery ${batt} • ${session.recording ? '● REC' : 'idle'}`;
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
    if (cam.connected) {
      ble.textContent = 'BLE: ✓';
      ble.className = 'chip ok';
    } else if (cam.reconnecting) {
      ble.textContent = 'BLE: ↻';
      ble.className = 'chip warn';
    } else {
      ble.textContent = 'BLE: ✗';
      ble.className = 'chip warn';
    }
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
  'start-0102':       { target: 0x0102, payload: [0x01], label: 'start@0102'       },
  'stop-0102':        { target: 0x0102, payload: [0x00], label: 'stop-00@0102'     },
  'stop-0102-alt1':   { target: 0x0102, payload: [0x02], label: 'stop-02@0102'     },
  'stop-0102-empty':  { target: 0x0102, payload: [],     label: 'stop-empty@0102'  },
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

// ---- Live preview (on-device RTMP via Capacitor MediaMtx plugin) --------
const mediaMtxPlugin = () =>
  (typeof window !== 'undefined' && window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.MediaMtx) || null;

const previewBtn = document.getElementById('btn-preview');
const previewStatus = document.getElementById('preview-status');
const previewUrlsEl = document.getElementById('preview-urls');
const previewHint = document.getElementById('preview-hint');

let previewRunning = false;

function setPreviewUi(running) {
  previewRunning = running;
  previewBtn.textContent = running ? 'Stop RTMP Server' : 'Start RTMP Server';
  previewStatus.textContent = running ? 'running' : 'idle';
  previewStatus.className = 'chip ' + (running ? 'ok' : '');
  previewUrlsEl.hidden = !running;
}

async function pickTabletIp() {
  const mmtx = mediaMtxPlugin();
  if (!mmtx) return null;
  try {
    const { addresses } = await mmtx.getLocalIps();
    if (!addresses || !addresses.length) return null;
    // Prefer 192.168.x.x (typical hotspot range) over other interfaces.
    const lan = addresses.find((a) => /^192\.168\./.test(a.ip));
    return lan || addresses[0];
  } catch (e) {
    log('warn', `getLocalIps failed: ${e.message}`);
    return null;
  }
}

function updatePreviewUrls(ip) {
  document.getElementById('url-rtmp1').textContent = `rtmp://${ip}:1935/cam1`;
  document.getElementById('url-rtmp2').textContent = `rtmp://${ip}:1935/cam2`;
  document.getElementById('url-hls1').textContent = `http://localhost:8888/cam1/index.m3u8`;
  document.getElementById('url-hls2').textContent = `http://localhost:8888/cam2/index.m3u8`;
}

if (!mediaMtxPlugin()) {
  previewHint.textContent = 'Live preview requires the Android APK build (MediaMtx plugin not available in browser).';
  previewBtn.disabled = true;
}

previewBtn.addEventListener('click', async () => {
  const mmtx = mediaMtxPlugin();
  if (!mmtx) return;
  try {
    if (!previewRunning) {
      await mmtx.start();
      setPreviewUi(true);
      const ipInfo = await pickTabletIp();
      const ip = ipInfo ? ipInfo.ip : '<tablet-ip>';
      updatePreviewUrls(ip);
      log('ok', `MediaMTX started. Push RTMP to rtmp://${ip}:1935/cam1 and /cam2`);
      // Auto-load the HLS URLs into the video panes. hls.js will handle retries
      // while waiting for the cameras to actually start publishing.
      const hls1 = `http://localhost:8888/cam1/index.m3u8`;
      const hls2 = `http://localhost:8888/cam2/index.m3u8`;
      document.getElementById('url1').value = hls1;
      document.getElementById('url2').value = hls2;
      pane1.load(hls1);
      pane2.load(hls2);
    } else {
      await mmtx.stop();
      setPreviewUi(false);
      log('ok', 'MediaMTX stopped.');
    }
  } catch (e) {
    log('err', `Preview toggle failed: ${e.message}`);
  }
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
