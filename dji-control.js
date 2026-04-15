// DJIControl — Web Bluetooth control for DJI Osmo Action cameras.
//
// Implements the "node-osmo / Moblin RTMP-livestream" protocol (SOF 0x55).
// This is the protocol that DJI's own Mimo app uses to configure RTMP
// livestreaming, and (based on empirical BLE capture from an Osmo Action 3)
// is the ONLY protocol the Action 3 speaks on characteristics FFF3/FFF4.
//
// Ported from:
//   - datagutt/node-osmo (TypeScript, MIT) — frame layout, pair token, state machine
//
// FRAME LAYOUT (all multibyte little-endian):
//   off  size  field
//    0    1    SOF = 0x55
//    1    1    totalLen  (including CRCs)
//    2    1    version = 0x04
//    3    1    CRC8(header[0..2])         poly 0x31, init 0xEE, reflected
//    4    2    target    (LE u16)
//    6    2    txId      (LE u16)
//    8    3    type      (LE u24)
//   11    N    payload
//   11+N  2    CRC16(bytes[0..end-2]) LE  CCITT-like, init 0x496C, reflected

// ---- BLE UUIDs ----------------------------------------------------------
const DJI_SERVICE      = '0000fff0-0000-1000-8000-00805f9b34fb';
const DJI_CHAR_WRITE   = '0000fff3-0000-1000-8000-00805f9b34fb';
const DJI_CHAR_NOTIFY  = '0000fff4-0000-1000-8000-00805f9b34fb';
const DJI_CHAR_NOTIFY2 = '0000fff5-0000-1000-8000-00805f9b34fb';

// ---- CRC8 — DJI header CRC (poly 0x31, init 0xEE, reflected) -----------
// Reflected poly = bit-reverse of 0x31 in 8 bits = 0x8C
const CRC8_TABLE = (() => {
  const t = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? ((c >>> 1) ^ 0x8C) : (c >>> 1);
    t[i] = c;
  }
  return t;
})();

// NOTE: reflected CRC init must be bit-reversed. node-osmo declares init=0xEE
// but crc-full reflects it to 0x77 internally. We pre-reflect here.
function djiCrc8(bytes) {
  let crc = 0x77; // bit-reverse of 0xEE
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC8_TABLE[(crc ^ bytes[i]) & 0xFF];
  }
  return crc & 0xFF;
}

// ---- CRC16 — DJI body CRC (poly 0x1021, init 0x496C, reflected) --------
// Reflected poly = bit-reverse of 0x1021 in 16 bits = 0x8408
const CRC16_TABLE = (() => {
  const t = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? ((c >>> 1) ^ 0x8408) : (c >>> 1);
    t[i] = c;
  }
  return t;
})();

function djiCrc16(bytes) {
  let crc = 0x3692; // bit-reverse of 0x496C
  for (let i = 0; i < bytes.length; i++) {
    crc = (CRC16_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8)) & 0xFFFF;
  }
  return crc;
}

// ---- Frame builder/parser -----------------------------------------------
function buildFrame(target, txId, type, payload) {
  const totalLen = 4 + 7 + payload.length + 2;
  if (totalLen > 255) throw new Error('Frame too large for 0x55 protocol');
  const out = new Uint8Array(totalLen);
  out[0] = 0x55;
  out[1] = totalLen;
  out[2] = 0x04;
  out[3] = djiCrc8(out.subarray(0, 3));
  out[4] = target & 0xFF;
  out[5] = (target >> 8) & 0xFF;
  out[6] = txId & 0xFF;
  out[7] = (txId >> 8) & 0xFF;
  out[8] = type & 0xFF;
  out[9] = (type >> 8) & 0xFF;
  out[10] = (type >> 16) & 0xFF;
  out.set(payload, 11);
  const crc = djiCrc16(out.subarray(0, totalLen - 2));
  out[totalLen - 2] = crc & 0xFF;
  out[totalLen - 1] = (crc >> 8) & 0xFF;
  return out;
}

function parseFrame(bytes) {
  if (bytes.length < 13) return { ok: false, reason: 'too short' };
  if (bytes[0] !== 0x55) return { ok: false, reason: `bad SOF 0x${bytes[0].toString(16)}` };
  const totalLen = bytes[1];
  if (bytes.length < totalLen) return { ok: false, reason: `short frame: need ${totalLen}, have ${bytes.length}` };
  if (bytes[2] !== 0x04) return { ok: false, reason: `bad version 0x${bytes[2].toString(16)}` };
  const headerCrc = bytes[3];
  const calcHeader = djiCrc8(bytes.subarray(0, 3));
  if (headerCrc !== calcHeader) return { ok: false, reason: `header crc8 mismatch got=${headerCrc.toString(16)} calc=${calcHeader.toString(16)}` };
  const target = bytes[4] | (bytes[5] << 8);
  const txId = bytes[6] | (bytes[7] << 8);
  const type = bytes[8] | (bytes[9] << 8) | (bytes[10] << 16);
  const payloadLen = totalLen - 13;
  const payload = bytes.subarray(11, 11 + payloadLen);
  const bodyCrc = bytes[11 + payloadLen] | (bytes[12 + payloadLen] << 8);
  const calcBody = djiCrc16(bytes.subarray(0, totalLen - 2));
  if (bodyCrc !== calcBody) {
    return { ok: false, reason: `crc16 mismatch got=${bodyCrc.toString(16)} calc=${calcBody.toString(16)}` };
  }
  return { ok: true, target, txId, type, payload, total: totalLen };
}

// ---- Message catalog ----------------------------------------------------
// Constants lifted verbatim from node-osmo/src/device.ts.
const PAIR_TARGET  = 0x0702;
const PAIR_TXID    = 0x8092;
const PAIR_TYPE    = 0x450740;

const STOP_STREAM_TARGET = 0x0802;
const STOP_STREAM_TXID   = 0xEAC8;
const STOP_STREAM_TYPE   = 0x8E0240;

const PREP_STREAM_TARGET = 0x0802;
const PREP_STREAM_TXID   = 0x8C12;
const PREP_STREAM_TYPE   = 0xE10240;

// ---- Record opcodes (confirmed on Osmo Action 3) -----------------------
// Empirically validated 2026-04-14 against a real Action 3:
//   target 0x0102, type 0x020240 (CmdSet=0x02/CmdID=0x02 "Do Record"),
//   payload [0x01] = start, payload [0x00] = stop.
// Camera replies on target 0x0201 with type 0x0202c0 payload [0x00] on
// success, [0xe0]/[0xe3] on various error conditions. Source for opcode:
// xaionaro-go/djictl + o-gs/dji-firmware-tools DJI DUML camera dissector.
const RECORD_TARGET    = 0x0102;
const RECORD_TYPE      = 0x020240;
const RECORD_START_PAYLOAD = new Uint8Array([0x01]);
const RECORD_STOP_PAYLOAD  = new Uint8Array([0x00]);
let   _recTxId = 0x9001;
function nextRecTxId() { _recTxId = (_recTxId + 1) & 0xFFFF; return _recTxId; }

// ---- Status push (camera -> remote, ~1 Hz) -----------------------------
// Empirically observed 34-byte payload. Only offset 20 is decoded so far
// (battery %). Other bytes vary across sessions but we haven't nailed them
// down — grow this parser as we decode more fields. Offset 17 appears
// session-specific (temperature? storage? unclear), offsets 27-28 are the
// constant `20 04` marker, offset 33 is always `01`.
const STATUS_PUSH_TARGET = 0x0205;
const STATUS_PUSH_TYPE   = 0x020d00;
const STATUS_PUSH_BATTERY_OFFSET = 20;

function parseStatusPush(payload) {
  const out = {};
  if (payload.length > STATUS_PUSH_BATTERY_OFFSET) {
    out.battery = payload[STATUS_PUSH_BATTERY_OFFSET];
  }
  return out;
}

// Hard-coded 33-byte pair token (ASCII " 284ae5b8d76b3375a04a6417ad71bea3")
// followed by djiPackString("love") = [0x04, 'l','o','v','e'].
const PAIR_TOKEN = new Uint8Array([
  0x20, 0x32, 0x38, 0x34, 0x61, 0x65, 0x35, 0x62, 0x38, 0x64, 0x37, 0x36,
  0x62, 0x33, 0x33, 0x37, 0x35, 0x61, 0x30, 0x34, 0x61, 0x36, 0x34, 0x31,
  0x37, 0x61, 0x64, 0x37, 0x31, 0x62, 0x65, 0x61, 0x33,
]);
const PAIR_PIN = new Uint8Array([0x04, 0x6c, 0x6f, 0x76, 0x65]); // len=4 + "love"

function buildPairPayload() {
  const out = new Uint8Array(PAIR_TOKEN.length + PAIR_PIN.length);
  out.set(PAIR_TOKEN, 0);
  out.set(PAIR_PIN, PAIR_TOKEN.length);
  return out;
}

// ---- DJIControl class ---------------------------------------------------
export class DJIControl extends EventTarget {
  constructor() {
    super();
    /** @type {Map<string, CameraSession>} */
    this.pairedCameras = new Map();
  }

  isSupported() { return 'bluetooth' in navigator; }

  log(kind, msg) { this.dispatchEvent(new CustomEvent('log', { detail: { kind, msg } })); }

  _emitStatus(session) {
    this.dispatchEvent(new CustomEvent('statusChange', { detail: { session } }));
  }

  async scanAndPair() {
    if (!this.isSupported()) throw new Error('Web Bluetooth not available. Use Chrome on Android over HTTPS or http://localhost.');

    const device = await navigator.bluetooth.requestDevice({
      acceptAllDevices: true,
      optionalServices: [DJI_SERVICE, 'battery_service'],
    });

    this.log('ok', `Selected ${device.name || device.id}. Connecting GATT…`);

    const session = new CameraSession(device, this);
    this.pairedCameras.set(device.id, session);
    this._emitStatus(session);

    try {
      await session.connect();
      await session.handshake();
      this.log('ok', `Handshake complete with ${device.name || device.id}`);
    } catch (e) {
      this.log('err', `Pairing failed for ${device.name || device.id}: ${e.message}`);
      this.pairedCameras.delete(device.id);
      try { session.disconnect(); } catch {}
      this._emitStatus(session);
      throw e;
    }

    this._emitStatus(session);
    return session;
  }

  async disconnect(deviceId) {
    const s = this.pairedCameras.get(deviceId);
    if (!s) return;
    s.disconnect();
    this.pairedCameras.delete(deviceId);
    this._emitStatus(s);
  }

  async startRecordAll() {
    return this._recordFanOut('start');
  }

  async stopRecordAll() {
    return this._recordFanOut('stop');
  }

  async _recordFanOut(action) {
    const sessions = Array.from(this.pairedCameras.values()).filter(s => s.connected);
    if (sessions.length === 0) throw new Error('No connected cameras');
    const payload = action === 'start' ? RECORD_START_PAYLOAD : RECORD_STOP_PAYLOAD;
    return Promise.all(sessions.map(async (s) => {
      const txId = nextRecTxId();
      try {
        const resp = await s.sendAndAwait({
          target: RECORD_TARGET,
          txId,
          type: RECORD_TYPE,
          payload,
          timeoutMs: 3000,
        });
        const status = resp.payload[0];
        if (status !== 0x00) {
          throw new Error(`camera returned error 0x${status.toString(16)}`);
        }
        s.recording = (action === 'start');
        this._emitStatus(s);
        return { ok: true, session: s };
      } catch (e) {
        return { ok: false, session: s, err: e };
      }
    }));
  }

  // Manual opcode probe — used for Action 4 testing when it arrives.
  async testRecordFrame({ target = RECORD_TARGET, type = RECORD_TYPE, payload = new Uint8Array(0), label = 'test' } = {}) {
    const sessions = Array.from(this.pairedCameras.values()).filter(s => s.connected);
    if (sessions.length === 0) {
      this.log('warn', 'No connected cameras. Pair first.');
      return;
    }
    const pl = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
    this.log('warn', `[REC TEST ${label}] target=0x${target.toString(16)} type=0x${type.toString(16)} payload=${pl.length ? hex(pl) : '(empty)'}`);
    for (const s of sessions) {
      const txId = nextRecTxId();
      try {
        const resp = await s.sendAndAwait({ target, txId, type, payload: pl, timeoutMs: 2500 });
        this.log('ok', `[REC TEST ${label}] ${s.device.name || s.device.id} responded: target=0x${resp.target.toString(16)} type=0x${resp.type.toString(16)} payload=${hex(resp.payload)}`);
      } catch (e) {
        this.log('warn', `[REC TEST ${label}] ${s.device.name || s.device.id}: no same-txId response (${e.message}). Watch camera screen + subsequent frames.`);
      }
    }
  }
}

// ---- CameraSession ------------------------------------------------------
class CameraSession {
  constructor(device, control) {
    this.device = device;
    this.control = control;
    this.server = null;
    this.service = null;
    this.writeChar = null;
    this.notifyChar = null;
    this.notifyChar2 = null;
    this.connected = false;
    this.recording = false;
    this.battery = null;
    this.rxBuffer = new Uint8Array(0);
    this.pendingByTxId = new Map(); // txId -> { resolve, reject, timer }
    this.onGattDisconnected = this.onGattDisconnected.bind(this);
  }

  label() { return this.device.name || this.device.id; }

  onGattDisconnected() {
    this.connected = false;
    this.control.log('warn', `${this.label()} disconnected`);
    this.control._emitStatus(this);
  }

  async connect() {
    this.device.addEventListener('gattserverdisconnected', this.onGattDisconnected);
    this.server = await this.device.gatt.connect();
    this.service = await this.server.getPrimaryService(DJI_SERVICE);
    this.writeChar = await this.service.getCharacteristic(DJI_CHAR_WRITE);
    this.notifyChar = await this.service.getCharacteristic(DJI_CHAR_NOTIFY);
    try {
      this.notifyChar2 = await this.service.getCharacteristic(DJI_CHAR_NOTIFY2);
    } catch { /* fff5 may not exist */ }

    this.notifyChar.addEventListener('characteristicvaluechanged', (ev) => this.onNotification(ev.target.value));
    await this.notifyChar.startNotifications();
    if (this.notifyChar2) {
      this.notifyChar2.addEventListener('characteristicvaluechanged', (ev) => this.onNotification(ev.target.value));
      try { await this.notifyChar2.startNotifications(); } catch {}
    }
    this.connected = true;
    this.control.log('ok', `GATT connected, notifications active`);
  }

  disconnect() {
    try {
      if (this.server && this.server.connected) this.server.disconnect();
    } catch {}
    this.connected = false;
  }

  onNotification(dv) {
    const incoming = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
    const merged = new Uint8Array(this.rxBuffer.length + incoming.length);
    merged.set(this.rxBuffer, 0);
    merged.set(incoming, this.rxBuffer.length);
    this.rxBuffer = merged;

    while (this.rxBuffer.length >= 13) {
      if (this.rxBuffer[0] !== 0x55) {
        const sof = this.rxBuffer.indexOf(0x55);
        if (sof < 0) { this.rxBuffer = new Uint8Array(0); return; }
        this.rxBuffer = this.rxBuffer.slice(sof);
        if (this.rxBuffer.length < 13) return;
      }
      const totalLen = this.rxBuffer[1];
      if (totalLen < 13) {
        // bogus, skip this byte
        this.rxBuffer = this.rxBuffer.slice(1);
        continue;
      }
      if (this.rxBuffer.length < totalLen) return; // wait for more
      const frame = this.rxBuffer.slice(0, totalLen);
      this.rxBuffer = this.rxBuffer.slice(totalLen);
      const parsed = parseFrame(frame);
      if (!parsed.ok) {
        this.control.log('warn', `frame parse error: ${parsed.reason} raw=${hex(frame)}`);
        continue;
      }
      this.dispatchFrame(parsed);
    }
  }

  dispatchFrame(f) {
    // Camera status push (~1 Hz) — handled quietly so the log doesn't flood.
    if (f.target === STATUS_PUSH_TARGET && f.type === STATUS_PUSH_TYPE) {
      const s = parseStatusPush(f.payload);
      if (typeof s.battery === 'number' && s.battery !== this.battery) {
        this.battery = s.battery;
        this.control.log('ok', `${this.label()} batt=${s.battery}%`);
        this.control._emitStatus(this);
      }
      return;
    }

    this.control.log('ok', `⇐ target=0x${f.target.toString(16)} txId=0x${f.txId.toString(16)} type=0x${f.type.toString(16)} payload=${hex(f.payload)}`);
    const waiter = this.pendingByTxId.get(f.txId);
    if (waiter) {
      clearTimeout(waiter.timer);
      this.pendingByTxId.delete(f.txId);
      waiter.resolve(f);
    }
  }

  async sendAndAwait({ target, txId, type, payload, timeoutMs = 5000 }) {
    const frame = buildFrame(target, txId, type, payload);
    this.control.log('ok', `⇒ target=0x${target.toString(16)} txId=0x${txId.toString(16)} type=0x${type.toString(16)} payload=${hex(payload)} [${frame.length}B]`);

    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingByTxId.delete(txId);
        reject(new Error(`Timeout awaiting response for txId=0x${txId.toString(16)}`));
      }, timeoutMs);
      this.pendingByTxId.set(txId, { resolve, reject, timer });
    });

    // Try writeWithoutResponse first (matches node-osmo's writeAsync(..., false));
    // fall back to writeValueWithResponse if the characteristic doesn't allow it.
    try {
      if (this.writeChar.writeValueWithoutResponse) {
        await this.writeChar.writeValueWithoutResponse(frame);
      } else {
        await this.writeChar.writeValue(frame);
      }
    } catch (e) {
      this.control.log('warn', `writeWithoutResponse failed (${e.message}), trying writeValue`);
      try { await this.writeChar.writeValue(frame); }
      catch (e2) {
        this.pendingByTxId.delete(txId);
        throw new Error(`write failed: ${e2.message}`);
      }
    }

    return promise;
  }

  async handshake() {
    // node-osmo sends a single pair message and waits for the camera's response
    // with the same txId. The payload of the response tells us whether we're
    // newly paired or already paired.
    const payload = buildPairPayload();
    const resp = await this.sendAndAwait({
      target: PAIR_TARGET,
      txId: PAIR_TXID,
      type: PAIR_TYPE,
      payload,
      timeoutMs: 20000,
    });
    this.control.log('ok', `Pair response: ${hex(resp.payload)}`);
    // payload of [0x00, 0x01] means "already paired". Other values = new pair accepted.
    // For our purposes, ANY response on the correct txId is a success.
  }
}

function hex(bytes) {
  if (!bytes || !bytes.length) return '';
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(' ');
}
