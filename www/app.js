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
  log('err', 'Bluetooth unavailable. Use the Android APK build, or Chrome on desktop over HTTPS/localhost.');
}
dji.addEventListener('log', (ev) => log(ev.detail.kind, ev.detail.msg));

// Eagerly initialize the BLE transport so the Android runtime permission
// prompts (BLUETOOTH_SCAN, BLUETOOTH_CONNECT) fire on first launch instead
// of when the user taps Pair. Also pops the "enable Bluetooth" system
// dialog if the radio is off. Failures are logged but non-fatal — the Pair
// button will retry init on click.
(async () => {
  if (!dji.isSupported()) return;
  log('ok', `BLE transport: ${dji.transport.name}`);
  try {
    await dji._ensureTransport();
    log('ok', 'Bluetooth ready.');
  } catch (e) {
    log('warn', `Bluetooth not ready yet: ${e.message}. Tap Pair to grant permissions.`);
  }
})();

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

// ---- Live preview (end-to-end on-device) --------------------------------
// Workflow:
//  1. User enables the tablet's hotspot (manual OS action).
//  2. User enters SSID + password in the app (persisted in localStorage).
//  3. User taps Start Preview:
//     a. MediaMtx Capacitor plugin starts MediaMTX on :1935 (RTMP in) and
//        :8888 (LL-HLS out).
//     b. We fetch the tablet's local IPs and pick the 192.168.x.x one.
//     c. For each connected camera we send setupWifi(ssid, password) then
//        startStreaming(rtmp://<tablet>:1935/camN) over BLE.
//     d. Video panes auto-load the HLS URLs; hls.js retries until the
//        cameras actually start publishing.
//  4. User taps Stop Preview: stopStreaming over BLE to each camera, then
//     MediaMtx.stop(). Cameras drop back to idle and are ready for record.
const mediaMtxPlugin = () =>
  (typeof window !== 'undefined' && window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.MediaMtx) || null;

const previewBtn = document.getElementById('btn-preview');
const previewStatus = document.getElementById('preview-status');
const previewHint = document.getElementById('preview-hint');
const previewSsid = document.getElementById('preview-ssid');
const previewPass = document.getElementById('preview-pass');

const PREVIEW_SSID_KEY = 'fmc-preview-ssid';
const PREVIEW_PASS_KEY = 'fmc-preview-pass';
previewSsid.value = localStorage.getItem(PREVIEW_SSID_KEY) || '';
previewPass.value = localStorage.getItem(PREVIEW_PASS_KEY) || '';
previewSsid.addEventListener('change', () => localStorage.setItem(PREVIEW_SSID_KEY, previewSsid.value));
previewPass.addEventListener('change', () => localStorage.setItem(PREVIEW_PASS_KEY, previewPass.value));

let previewRunning = false;

function setPreviewUi(running, label) {
  previewRunning = running;
  previewBtn.textContent = running ? 'Stop Preview' : 'Start Preview';
  previewStatus.textContent = label || (running ? 'streaming' : 'idle');
  previewStatus.className = 'chip ' + (running ? 'ok' : '');
}

async function pickTabletIp() {
  const mmtx = mediaMtxPlugin();
  if (!mmtx) return null;
  try {
    const { addresses } = await mmtx.getLocalIps();
    if (!addresses || !addresses.length) return null;
    const lan = addresses.find((a) => /^192\.168\./.test(a.ip));
    return lan || addresses[0];
  } catch (e) {
    log('warn', `getLocalIps failed: ${e.message}`);
    return null;
  }
}

if (!mediaMtxPlugin()) {
  previewHint.textContent = 'Live preview requires the Android APK build (MediaMtx plugin is not available in a regular browser).';
  previewBtn.disabled = true;
  previewSsid.disabled = true;
  previewPass.disabled = true;
}

previewBtn.addEventListener('click', async () => {
  const mmtx = mediaMtxPlugin();
  if (!mmtx) return;

  if (!previewRunning) {
    const ssid = previewSsid.value.trim();
    const pass = previewPass.value;
    if (!ssid) { log('err', 'Enter your hotspot SSID first.'); return; }
    if (dji.pairedCameras.size === 0) { log('err', 'Pair at least one camera first.'); return; }

    localStorage.setItem(PREVIEW_SSID_KEY, ssid);
    localStorage.setItem(PREVIEW_PASS_KEY, pass);

    previewBtn.disabled = true;
    setPreviewUi(false, 'starting server…');
    try {
      await mmtx.start();
    } catch (e) {
      log('err', `MediaMTX start failed: ${e.message}`);
      previewBtn.disabled = false;
      setPreviewUi(false, 'idle');
      return;
    }

    setPreviewUi(false, 'finding tablet IP…');
    const ipInfo = await pickTabletIp();
    if (!ipInfo) {
      log('err', 'Could not determine tablet IP. Is the hotspot enabled?');
      previewBtn.disabled = false;
      setPreviewUi(false, 'idle');
      return;
    }
    const baseRtmpUrl = `rtmp://${ipInfo.ip}:1935`;
    log('ok', `MediaMTX running on ${ipInfo.iface} ${ipInfo.ip}. Pushing cameras to ${baseRtmpUrl}/camN…`);

    setPreviewUi(false, 'configuring cameras…');
    let results;
    try {
      results = await dji.startPreviewAll({ ssid, password: pass, baseRtmpUrl });
    } catch (e) {
      log('err', `Preview setup failed: ${e.message}`);
      try { await mmtx.stop(); } catch {}
      previewBtn.disabled = false;
      setPreviewUi(false, 'idle');
      return;
    }

    const okCount = results.filter(r => r.ok).length;
    if (okCount === 0) {
      log('err', 'All cameras failed to start streaming. Stopping server.');
      try { await mmtx.stop(); } catch {}
      previewBtn.disabled = false;
      setPreviewUi(false, 'idle');
      return;
    }

    // Point the video panes at the HLS endpoints. hls.js will retry until
    // the camera actually starts publishing.
    results.forEach((r, i) => {
      if (!r.ok) return;
      const hlsUrl = `http://localhost:8888/cam${i + 1}/index.m3u8`;
      const urlInput = document.getElementById(`url${i + 1}`);
      if (urlInput) urlInput.value = hlsUrl;
      const pane = i === 0 ? pane1 : pane2;
      if (pane) pane.load(hlsUrl);
    });

    previewBtn.disabled = false;
    setPreviewUi(true, `streaming (${okCount}/${results.length})`);
    log('ok', `Preview running. ${okCount}/${results.length} cameras streaming.`);

  } else {
    previewBtn.disabled = true;
    setPreviewUi(true, 'stopping cameras…');
    try {
      const results = await dji.stopPreviewAll();
      const okCount = results.filter(r => r.ok).length;
      log('ok', `Preview stop fan-out: ${okCount}/${results.length}`);
    } catch (e) {
      log('warn', `stopPreviewAll error: ${e.message}`);
    }
    try { await mmtx.stop(); } catch (e) { log('warn', `MediaMTX stop error: ${e.message}`); }
    pane1.load('');
    pane2.load('');
    previewBtn.disabled = false;
    setPreviewUi(false, 'idle');
    log('ok', 'Preview stopped. Cameras idle.');
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
