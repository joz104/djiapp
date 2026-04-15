import { DJIControl } from './dji-control.js';
import { VideoPane } from './video-pane.js';

// ---- StitchRenderer ------------------------------------------------------
// Canvas 2D compositor that draws both camera video elements into a single
// wide canvas at 30 fps. Used by the "Stitched" view mode. The two streams
// are positioned based on a one-time calibration (FoV + angle between
// cameras), then blended across the overlap zone either with a feathered
// alpha ramp (default) or a hard seam (calibration mode).
//
// NOT a real homographic stitch — straight lines won't stay perfectly
// straight across the seam — but good enough for live framing on a
// tripod-mounted pair where calibration is static.
class StitchRenderer {
  constructor(canvas, videoA, videoB) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.videoA = videoA;
    this.videoB = videoB;
    this.fovDeg = 80;
    this.angleDeg = 0;
    this.blend = 'feather';
    this.running = false;
    this._rafHandle = 0;
    this._mask = document.createElement('canvas');
    this._maskCtx = this._mask.getContext('2d');
  }

  setCalibration({ fovDeg, angleDeg, blend }) {
    if (Number.isFinite(fovDeg))   this.fovDeg   = Math.max(20, Math.min(180, fovDeg));
    if (Number.isFinite(angleDeg)) this.angleDeg = Math.max(0,  Math.min(180, angleDeg));
    if (blend) this.blend = blend;
  }

  start() {
    if (this.running) return;
    this.running = true;
    const tick = () => {
      if (!this.running) return;
      this.draw();
      this._rafHandle = requestAnimationFrame(tick);
    };
    this._rafHandle = requestAnimationFrame(tick);
  }

  stop() {
    this.running = false;
    if (this._rafHandle) cancelAnimationFrame(this._rafHandle);
    this._rafHandle = 0;
  }

  draw() {
    const a = this.videoA, b = this.videoB;
    const wA = a.videoWidth  || 0;
    const hA = a.videoHeight || 0;
    const wB = b.videoWidth  || 0;
    const hB = b.videoHeight || 0;

    // If neither source has loaded a frame yet, paint a placeholder.
    if (!wA && !wB) {
      if (this.canvas.width !== 640)  this.canvas.width = 640;
      if (this.canvas.height !== 360) this.canvas.height = 360;
      this.ctx.fillStyle = '#0b0b0f';
      this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
      return;
    }

    // If only one side has a frame, draw just that one full-bleed.
    if (!wA || !wB) {
      const src = wA ? a : b;
      const sw = wA || wB, sh = hA || hB;
      if (this.canvas.width !== sw) this.canvas.width = sw;
      if (this.canvas.height !== sh) this.canvas.height = sh;
      this.ctx.drawImage(src, 0, 0, sw, sh);
      return;
    }

    const h = Math.max(hA, hB);
    const overlapFrac = Math.max(0, Math.min(1, (this.fovDeg - this.angleDeg) / this.fovDeg));
    const overlapPx = Math.round(wA * overlapFrac);
    const outW = wA + wB - overlapPx;

    if (this.canvas.width !== outW) this.canvas.width = outW;
    if (this.canvas.height !== h)   this.canvas.height = h;

    const ctx = this.ctx;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, outW, h);

    if (this.blend === 'hard' || overlapPx === 0) {
      ctx.drawImage(a, 0, 0, wA, h);
      ctx.drawImage(b, wA - overlapPx, 0, wB, h);
      return;
    }

    // Feather: draw cam2 first (full), then cam1 with its right edge
    // fading out across the overlap zone, so cam2 shows through there.
    ctx.drawImage(b, wA - overlapPx, 0, wB, h);

    if (this._mask.width !== wA) this._mask.width = wA;
    if (this._mask.height !== h) this._mask.height = h;
    const mctx = this._maskCtx;
    mctx.globalCompositeOperation = 'source-over';
    mctx.clearRect(0, 0, wA, h);
    mctx.drawImage(a, 0, 0, wA, h);
    mctx.globalCompositeOperation = 'destination-in';
    const grad = mctx.createLinearGradient(wA - overlapPx, 0, wA, 0);
    grad.addColorStop(0, 'rgba(0,0,0,1)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    mctx.fillStyle = grad;
    mctx.fillRect(wA - overlapPx, 0, overlapPx, h);
    mctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(this._mask, 0, 0, wA, h);
  }
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch((e) => log('err', `SW register failed: ${e.message}`));
}

const logEl = document.getElementById('log');
function log(kind, msg) {
  const line = document.createElement('div');
  line.className = kind;
  const ts = new Date().toLocaleTimeString();
  const full = `[${ts}] ${msg}`;
  line.textContent = full;
  logEl.appendChild(line);
  while (logEl.childNodes.length > 200) logEl.removeChild(logEl.firstChild);
  logEl.scrollTop = logEl.scrollHeight;
  // Mirror to console so Capacitor routes it into Android Logcat under
  // tag 'Capacitor/Console'. Lets us grep `adb logcat` directly instead
  // of hand-copying from the UI panel.
  const tag = `[FMC:${kind}]`;
  if (kind === 'err') console.error(tag, msg);
  else if (kind === 'warn') console.warn(tag, msg);
  else console.log(tag, msg);
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
//
// After init succeeds, immediately try to auto-reconnect to the last
// paired device (deviceId saved in localStorage by scanAndPair). This
// is why you don't have to re-pair every app launch any more. If the
// camera is off / out of range, it just logs a warning and the Pair
// button still works normally.
(async () => {
  if (!dji.isSupported()) return;
  log('ok', `BLE transport: ${dji.transport.name}`);
  try {
    await dji._ensureTransport();
    log('ok', 'Bluetooth ready.');
  } catch (e) {
    log('warn', `Bluetooth not ready yet: ${e.message}. Tap Pair to grant permissions.`);
    return;
  }
  try {
    const session = await dji.autoPairLast();
    if (session) {
      log('ok', `Auto-reconnected to ${session.device.name || session.device.id}`);
    }
  } catch (e) {
    log('warn', `Auto-reconnect skipped: ${e.message}`);
  }
})();

const pane1 = new VideoPane(document.getElementById('video1'), 1);
const pane2 = new VideoPane(document.getElementById('video2'), 2);
pane1.onLog = log;
pane2.onLog = log;

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
let masterRecordStartedAt = 0;
let masterTimerHandle = null;

function formatElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

function applyMasterUi() {
  masterBtn.setAttribute('aria-pressed', String(masterRecording));
  if (masterRecording) {
    const elapsed = formatElapsed(Date.now() - masterRecordStartedAt);
    masterLabel.textContent = `RECORDING ${elapsed} — TAP TO STOP`;
  } else {
    masterLabel.textContent = 'MASTER RECORD';
  }
}

function startMasterTimer() {
  stopMasterTimer();
  masterTimerHandle = setInterval(applyMasterUi, 500);
}
function stopMasterTimer() {
  if (masterTimerHandle) {
    clearInterval(masterTimerHandle);
    masterTimerHandle = null;
  }
}

masterBtn.addEventListener('click', async () => {
  if (dji.pairedCameras.size === 0) {
    log('warn', 'No cameras paired. Tap "+ Pair" first.');
    return;
  }
  const starting = !masterRecording;
  // Optimistic UI — the click feedback needs to be instant on a tablet.
  masterRecording = starting;
  if (starting) {
    masterRecordStartedAt = Date.now();
    startMasterTimer();
  } else {
    stopMasterTimer();
  }
  applyMasterUi();
  try {
    const results = starting ? await dji.startRecordAll() : await dji.stopRecordAll();
    const okCount = results.filter((r) => r.ok).length;
    log(okCount === results.length ? 'ok' : 'err',
      `${starting ? 'START' : 'STOP'} fan-out: ${okCount}/${results.length} succeeded`);
    for (const r of results) {
      if (!r.ok) log('err', `  ${r.session.device.name || r.session.device.id}: ${r.err?.message || r.err}`);
    }
    if (okCount === 0) {
      // Every camera rejected — roll back the UI.
      masterRecording = !starting;
      if (masterRecording) {
        masterRecordStartedAt = Date.now();
        startMasterTimer();
      } else {
        stopMasterTimer();
      }
      applyMasterUi();
    }
  } catch (e) {
    log('err', `Record fan-out error: ${e.message}`);
    masterRecording = !starting;
    if (masterRecording) startMasterTimer();
    else stopMasterTimer();
    applyMasterUi();
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
const previewBtnLabel = document.getElementById('btn-preview-label');
const previewBtnMain = document.getElementById('btn-preview-main');
const previewBtnMainLabel = document.getElementById('btn-preview-main-label');
const previewStatus = document.getElementById('preview-status');
const previewHint = document.getElementById('preview-hint');
const previewSsid = document.getElementById('preview-ssid');
const previewPass = document.getElementById('preview-pass');
const previewRes = document.getElementById('preview-res');
const previewFps = document.getElementById('preview-fps');
const previewBr  = document.getElementById('preview-br');

const PREVIEW_SSID_KEY = 'fmc-preview-ssid';
const PREVIEW_PASS_KEY = 'fmc-preview-pass';
const PREVIEW_RES_KEY  = 'fmc-preview-res';
const PREVIEW_FPS_KEY  = 'fmc-preview-fps';
const PREVIEW_BR_KEY   = 'fmc-preview-br';

previewSsid.value = localStorage.getItem(PREVIEW_SSID_KEY) || '';
previewPass.value = localStorage.getItem(PREVIEW_PASS_KEY) || '';
previewRes.value  = localStorage.getItem(PREVIEW_RES_KEY)  || previewRes.value;
previewFps.value  = localStorage.getItem(PREVIEW_FPS_KEY)  || previewFps.value;
previewBr.value   = localStorage.getItem(PREVIEW_BR_KEY)   || previewBr.value;

// Use `input` for text fields so the value persists on every keystroke —
// `change` only fires on blur, and on Android the user often taps Start
// Preview before the keyboard dismisses so change never runs. `change` is
// still fine for <select> elements.
previewSsid.addEventListener('input',  () => localStorage.setItem(PREVIEW_SSID_KEY, previewSsid.value));
previewPass.addEventListener('input',  () => localStorage.setItem(PREVIEW_PASS_KEY, previewPass.value));

// Show / Hide password toggle. Lets the user verify what's actually stored
// in the field — catches typos hiding behind the password dots (the real
// cause of the 'Kam8nga69!' vs 'Kaminga69!' debug session).
const previewPassToggle = document.getElementById('preview-pass-toggle');
previewPassToggle.addEventListener('click', () => {
  const showing = previewPass.type === 'text';
  previewPass.type = showing ? 'password' : 'text';
  previewPassToggle.textContent = showing ? 'Show' : 'Hide';
  previewPassToggle.setAttribute('aria-pressed', String(!showing));
  previewPassToggle.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
});
previewRes.addEventListener('change',  () => localStorage.setItem(PREVIEW_RES_KEY, previewRes.value));
previewFps.addEventListener('change',  () => localStorage.setItem(PREVIEW_FPS_KEY, previewFps.value));
previewBr.addEventListener('change',   () => localStorage.setItem(PREVIEW_BR_KEY, previewBr.value));

// Preview state is the single source of truth. Both the drawer button
// (#btn-preview) and the topbar button (#btn-preview-main) always
// reflect this — every state transition MUST go through setPreviewUi.
let previewRunning = false;

// Mid-flight status labels that should be shown on the topbar button too
// so the home screen isn't a black hole during the ~30s setupWifi wait.
const MID_FLIGHT_LABELS = new Set([
  'starting server…',
  'finding tablet IP…',
  'configuring cameras…',
  'stopping cameras…',
]);

function setPreviewUi(running, label) {
  previewRunning = running;
  const baseTxt = running ? 'Stop Preview' : 'Start Preview';
  // Both buttons now contain an SVG icon alongside the text, so we must
  // write to the inner <span id="*-label"> to avoid wiping the icon.
  previewBtnLabel.textContent = baseTxt;
  if (label && MID_FLIGHT_LABELS.has(label)) {
    previewBtnMainLabel.textContent = label;
  } else {
    previewBtnMainLabel.textContent = baseTxt;
  }
  previewBtnMain.classList.toggle('btn-preview-active', running);
  previewBtn.classList.toggle('btn-preview-active', running);
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
  previewBtnMain.disabled = true;
  previewSsid.disabled = true;
  previewPass.disabled = true;
  previewRes.disabled = true;
  previewFps.disabled = true;
  previewBr.disabled = true;
}

function setPreviewBusy(busy) {
  previewBtn.disabled = busy;
  previewBtnMain.disabled = busy;
}

async function onPreviewClick() {
  const mmtx = mediaMtxPlugin();
  if (!mmtx) return;

  if (!previewRunning) {
    const ssid = previewSsid.value.trim();
    const pass = previewPass.value;
    if (!ssid) {
      log('err', 'Enter your hotspot SSID in Setup first.');
      openSetup();
      return;
    }
    if (dji.pairedCameras.size === 0) { log('err', 'Pair at least one camera first.'); return; }

    localStorage.setItem(PREVIEW_SSID_KEY, ssid);
    localStorage.setItem(PREVIEW_PASS_KEY, pass);

    setPreviewBusy(true);
    setPreviewUi(false, 'starting server…');
    try {
      await mmtx.start();
    } catch (e) {
      log('err', `MediaMTX start failed: ${e.message}`);
      setPreviewBusy(false);
      setPreviewUi(false, 'idle');
      return;
    }

    setPreviewUi(false, 'finding tablet IP…');
    const ipInfo = await pickTabletIp();
    if (!ipInfo) {
      log('err', 'Could not determine tablet IP. Is the hotspot enabled?');
      setPreviewBusy(false);
      setPreviewUi(false, 'idle');
      return;
    }
    const baseRtmpUrl = `rtmp://${ipInfo.ip}:1935`;
    log('ok', `MediaMTX running on ${ipInfo.iface} ${ipInfo.ip}. Pushing cameras to ${baseRtmpUrl}/camN…`);

    setPreviewUi(false, 'configuring cameras…');
    const resolution = previewRes.value;
    const fps = Number(previewFps.value);
    const bitrateKbps = Number(previewBr.value);
    log('ok', `Preview quality: ${resolution} @ ${fps}fps ${bitrateKbps}kbps`);
    let results;
    try {
      results = await dji.startPreviewAll({ ssid, password: pass, baseRtmpUrl, resolution, fps, bitrateKbps });
    } catch (e) {
      log('err', `Preview setup failed: ${e.message}`);
      try { await mmtx.stop(); } catch {}
      setPreviewBusy(false);
      setPreviewUi(false, 'idle');
      return;
    }

    const okCount = results.filter(r => r.ok).length;
    if (okCount === 0) {
      log('err', 'All cameras failed to start streaming. Stopping server.');
      try { await mmtx.stop(); } catch {}
      setPreviewBusy(false);
      setPreviewUi(false, 'idle');
      return;
    }

    results.forEach((r, i) => {
      if (!r.ok) return;
      const hlsUrl = `http://localhost:8888/cam${i + 1}/index.m3u8`;
      const pane = i === 0 ? pane1 : pane2;
      if (pane) pane.load(hlsUrl);
    });

    setPreviewBusy(false);
    setPreviewUi(true, `streaming (${okCount}/${results.length})`);
    log('ok', `Preview running. ${okCount}/${results.length} cameras streaming.`);

  } else {
    setPreviewBusy(true);
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
    setPreviewBusy(false);
    setPreviewUi(false, 'idle');
    log('ok', 'Preview stopped. Cameras idle.');
  }
}

previewBtn.addEventListener('click', onPreviewClick);
previewBtnMain.addEventListener('click', onPreviewClick);

// On app reload / resume, ask the MediaMtx plugin whether the server is
// still running. The foreground service survives the WebView being killed
// and reloaded, so we need to resync the UI instead of defaulting both
// buttons to "Start Preview" when the cameras are actually still live.
(async () => {
  const mmtx = mediaMtxPlugin();
  if (!mmtx) return;
  try {
    const status = await mmtx.status();
    if (status && status.running) {
      // MediaMtx is still running from a prior session. We don't have BLE
      // sessions to the cameras in this WebView context so we can't cleanly
      // stop them from here, but we DO have HLS endpoints that should still
      // be serving. Resync the UI and reload the panes.
      log('warn', 'MediaMTX was already running from a prior session. Restoring preview UI.');
      setPreviewUi(true, 'streaming (restored)');
      pane1.load('http://localhost:8888/cam1/index.m3u8');
      pane2.load('http://localhost:8888/cam2/index.m3u8');
    }
  } catch (e) {
    log('warn', `MediaMtx status check failed: ${e.message}`);
  }
})();

// ---- Setup drawer (right-side slide-in) ---------------------------------
const setupDrawer = document.getElementById('setup-drawer');
const setupBackdrop = document.getElementById('setup-backdrop');
const btnSetup = document.getElementById('btn-setup');
const btnCloseSetup = document.getElementById('btn-close-setup');

function openSetup() {
  setupDrawer.classList.add('open');
  setupBackdrop.hidden = false;
}
function closeSetup() {
  setupDrawer.classList.remove('open');
  setupBackdrop.hidden = true;
}
btnSetup.addEventListener('click', openSetup);
btnCloseSetup.addEventListener('click', closeSetup);
setupBackdrop.addEventListener('click', closeSetup);

// ---- View mode toggle (split / stitched) + stitch renderer --------------
const VIEW_MODE_KEY = 'fmc-view-mode';
const btnView = document.getElementById('btn-view');
const viewLabel = document.getElementById('view-label');
const gridEl = document.querySelector('main.grid');

const stitchCanvas = document.getElementById('stitch-canvas');
const stitchFov    = document.getElementById('stitch-fov');
const stitchAngle  = document.getElementById('stitch-angle');
const stitchBlend  = document.getElementById('stitch-blend');
const STITCH_FOV_KEY   = 'fmc-stitch-fov';
const STITCH_ANGLE_KEY = 'fmc-stitch-angle';
const STITCH_BLEND_KEY = 'fmc-stitch-blend';
stitchFov.value   = localStorage.getItem(STITCH_FOV_KEY)   || stitchFov.value;
stitchAngle.value = localStorage.getItem(STITCH_ANGLE_KEY) || stitchAngle.value;
stitchBlend.value = localStorage.getItem(STITCH_BLEND_KEY) || stitchBlend.value;

const stitcher = new StitchRenderer(stitchCanvas, pane1.videoEl, pane2.videoEl);
stitcher.setCalibration({
  fovDeg: Number(stitchFov.value),
  angleDeg: Number(stitchAngle.value),
  blend: stitchBlend.value,
});

function onStitchCalibChange() {
  stitcher.setCalibration({
    fovDeg: Number(stitchFov.value),
    angleDeg: Number(stitchAngle.value),
    blend: stitchBlend.value,
  });
  localStorage.setItem(STITCH_FOV_KEY, stitchFov.value);
  localStorage.setItem(STITCH_ANGLE_KEY, stitchAngle.value);
  localStorage.setItem(STITCH_BLEND_KEY, stitchBlend.value);
}
stitchFov.addEventListener('input', onStitchCalibChange);
stitchAngle.addEventListener('input', onStitchCalibChange);
stitchBlend.addEventListener('change', onStitchCalibChange);

function applyViewMode(mode) {
  const m = mode === 'stitched' ? 'stitched' : 'split';
  gridEl.setAttribute('data-view', m);
  viewLabel.textContent = m === 'stitched' ? 'View: Stitched' : 'View: Split';
  localStorage.setItem(VIEW_MODE_KEY, m);
  if (m === 'stitched') stitcher.start();
  else stitcher.stop();
}
applyViewMode(localStorage.getItem(VIEW_MODE_KEY) || 'split');
btnView.addEventListener('click', () => {
  const current = gridEl.getAttribute('data-view');
  applyViewMode(current === 'stitched' ? 'split' : 'stitched');
});

// ---- Log modal + collapsed bar ------------------------------------------
const logBar = document.getElementById('log-bar');
const logLatest = document.getElementById('log-latest');
const logModal = document.getElementById('log-modal');
const btnCloseLog = document.getElementById('btn-close-log');

// Mirror the latest log line into the collapsed log bar. MutationObserver
// keeps this decoupled from the log() function so we don't reshuffle the
// file to define logLatest before log().
new MutationObserver(() => {
  const last = logEl.lastElementChild;
  if (last) logLatest.textContent = last.textContent.replace(/^\[[\d:\s]+\]\s*/, '');
}).observe(logEl, { childList: true });

function openLogModal() {
  logModal.hidden = false;
  logEl.scrollTop = logEl.scrollHeight;
}
function closeLogModal() {
  logModal.hidden = true;
}
logBar.addEventListener('click', openLogModal);
logBar.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openLogModal(); }
});
btnCloseLog.addEventListener('click', closeLogModal);

document.getElementById('btn-copy-log').addEventListener('click', async () => {
  const text = Array.from(logEl.childNodes).map((n) => n.textContent).join('\n');
  try {
    await navigator.clipboard.writeText(text);
    log('ok', `Copied ${text.length} chars to clipboard.`);
  } catch (e) {
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
  logLatest.textContent = 'cleared';
});

// ---- Dev mode unlock (hidden probe panel for opcode reverse-engineering)
// The panel lives inside the setup drawer but is hidden by default so end
// users never see it. Unlock by long-pressing the topbar title for 3s;
// the flag persists in localStorage.fmc-dev so it survives reloads.
const DEV_FLAG_KEY = 'fmc-dev';
const devProbePanel = document.getElementById('dev-probe-panel');
function setDevMode(on) {
  if (on) {
    localStorage.setItem(DEV_FLAG_KEY, '1');
    if (devProbePanel) devProbePanel.hidden = false;
    log('warn', 'Dev mode active — Mode Switch Probes panel enabled in Setup.');
  } else {
    localStorage.removeItem(DEV_FLAG_KEY);
    if (devProbePanel) devProbePanel.hidden = true;
    log('ok', 'Dev mode disabled.');
  }
}
if (localStorage.getItem(DEV_FLAG_KEY) === '1' ||
    new URLSearchParams(location.search).has('dev')) {
  setDevMode(true);
}

// Long-press the topbar title (3s) to toggle dev mode.
(() => {
  const title = document.querySelector('.md-topbar-title');
  if (!title) return;
  let timer = null;
  const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
  const start = () => {
    cancel();
    timer = setTimeout(() => {
      const on = localStorage.getItem(DEV_FLAG_KEY) !== '1';
      setDevMode(on);
      timer = null;
    }, 3000);
  };
  title.addEventListener('touchstart',  start, { passive: true });
  title.addEventListener('mousedown',   start);
  title.addEventListener('touchend',    cancel);
  title.addEventListener('touchcancel', cancel);
  title.addEventListener('mouseup',     cancel);
  title.addEventListener('mouseleave',  cancel);
})();

// Wire every [data-probe] button to fire its frame via testRecordFrame
// (which logs both the outgoing and any same-txId response). Payload is
// a hex string in the data attribute, e.g. "01" or "0100" or "" for empty.
document.querySelectorAll('[data-probe]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const target = parseInt(btn.dataset.target, 16);
    const type   = parseInt(btn.dataset.type, 16);
    const payHex = (btn.dataset.payload || '').replace(/\s+/g, '');
    const payload = new Uint8Array((payHex.match(/.{1,2}/g) || []).map(h => parseInt(h, 16)));
    const label = btn.textContent.trim();
    try {
      await dji.testRecordFrame({ target, type, payload, label });
    } catch (e) {
      log('err', `Probe ${label}: ${e.message}`);
    }
  });
});

log('ok', 'Field Multi-Cam ready. Tap Setup to configure.');
log('warn', 'Protocol: node-osmo 0x55 (Action 3 compatible). Capacitor APK build.');
