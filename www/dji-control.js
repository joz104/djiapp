import { selectTransport } from './ble-transport.js';

// DJIControl — BLE control for DJI Osmo Action cameras.
//
// Multi-protocol architecture: DJIControl owns a Map of CameraSession
// instances, each of which delegates every byte of its I/O to a
// ProtocolDriver object. Today we ship:
//   - dji55Driver — the node-osmo / Moblin 0x55 DUML-over-BLE protocol,
//                   empirically confirmed on the Osmo Action 3 (pair +
//                   record start/stop both working end-to-end).
//   - dji0xaaDriver — stub for the DJI-SDK / rhoenschrat 0xAA protocol.
//                     All methods throw until someone captures Action 4
//                     frames and fills it in.
// New protocols = new driver object + entry in DRIVERS. CameraSession
// should not need to change.
//
// Ported from:
//   - datagutt/node-osmo (TypeScript, MIT) — frame layout, pair token, state machine
//
// 0x55 FRAME LAYOUT (all multibyte little-endian):
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

// ---- 0xAA protocol CRCs (DJI R-SDK, used by Action 4+) ------------------
// CRC16-MODBUS: poly 0x8005, init 0xFFFF, reflected
const CRC16M_TABLE = (() => {
  const t = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? ((c >>> 1) ^ 0xA001) : (c >>> 1);
    t[i] = c;
  }
  return t;
})();

function crc16modbus(bytes) {
  let crc = 0xFFFF;
  for (let i = 0; i < bytes.length; i++) {
    crc = (CRC16M_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8)) & 0xFFFF;
  }
  return crc;
}

// CRC32: poly 0x04C11DB7, init 0xFFFFFFFF, reflected, final XOR 0xFFFFFFFF
const CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? ((c >>> 1) ^ 0xEDB88320) : (c >>> 1);
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) {
    crc = (CRC32_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// ---- 0xAA frame builder/parser ------------------------------------------
// Frame layout (R-SDK):
//   off  size  field
//    0    1    SOF = 0xAA
//    1    2    ver(6b)|length(10b), LE
//    3    1    CmdType  (bit5=isResponse, bits[4:0]=ack mode)
//    4    1    ENC (0x00 = none)
//    5    3    reserved (zeros)
//    8    2    SEQ (LE)
//   10    2    CRC16-MODBUS(bytes[0..9])
//   12    1    CmdSet
//   13    1    CmdID
//   14    N    data payload
//  14+N   4    CRC32(bytes[0..13+N])

let _aaSeq = 1;
function nextAASeq() { _aaSeq = (_aaSeq + 1) & 0xFFFF; return _aaSeq; }

function buildAAFrame(seq, cmdSet, cmdId, payload) {
  const totalLen = 14 + payload.length + 4;
  const buf = new Uint8Array(totalLen);
  buf[0] = 0xAA;
  const verLen = (1 << 10) | (totalLen & 0x3FF);
  buf[1] = verLen & 0xFF;
  buf[2] = (verLen >> 8) & 0xFF;
  buf[3] = 0x01; // command, response optional
  buf[4] = 0x00; // no encryption
  buf[8] = seq & 0xFF;
  buf[9] = (seq >> 8) & 0xFF;
  const c16 = crc16modbus(buf.subarray(0, 10));
  buf[10] = c16 & 0xFF;
  buf[11] = (c16 >> 8) & 0xFF;
  buf[12] = cmdSet;
  buf[13] = cmdId;
  if (payload.length > 0) buf.set(payload, 14);
  const c32 = crc32(buf.subarray(0, totalLen - 4));
  buf[totalLen - 4] = c32 & 0xFF;
  buf[totalLen - 3] = (c32 >> 8) & 0xFF;
  buf[totalLen - 2] = (c32 >> 16) & 0xFF;
  buf[totalLen - 1] = (c32 >> 24) & 0xFF;
  return buf;
}

function parseAAFrame(bytes) {
  if (bytes.length < 16) return { ok: false, reason: 'too short for 0xAA' };
  if (bytes[0] !== 0xAA) return { ok: false, reason: `bad SOF 0x${bytes[0].toString(16)}` };
  const verLen = bytes[1] | (bytes[2] << 8);
  const totalLen = verLen & 0x3FF;
  if (totalLen < 16 || bytes.length < totalLen) return { ok: false, reason: `need ${totalLen}, have ${bytes.length}` };
  const headerCrc = bytes[10] | (bytes[11] << 8);
  if (headerCrc !== crc16modbus(bytes.subarray(0, 10))) return { ok: false, reason: 'header crc16 mismatch' };
  const frameCrc = (bytes[totalLen - 4] | (bytes[totalLen - 3] << 8) |
    (bytes[totalLen - 2] << 16) | ((bytes[totalLen - 1] << 24) >>> 0)) >>> 0;
  if (frameCrc !== crc32(bytes.subarray(0, totalLen - 4))) return { ok: false, reason: 'body crc32 mismatch' };
  return {
    ok: true,
    seq: bytes[8] | (bytes[9] << 8),
    cmdSet: bytes[12],
    cmdId: bytes[13],
    isResponse: !!(bytes[3] & 0x20),
    payload: bytes.subarray(14, totalLen - 4),
    total: totalLen,
  };
}

// 0xAA record command: CmdSet=0x1D, CmdID=0x03
// Payload: device_id(4B LE) + record_ctrl(1B) + reserved(4B)
const AA_REC_CMDSET = 0x1D;
const AA_REC_CMDID  = 0x03;

function buildAARecordPayload(start) {
  const buf = new Uint8Array(9);
  buf[0] = 0x33; buf[1] = 0xFF; // device_id = 0xFF33 LE
  buf[4] = start ? 0x00 : 0x01; // 0x00 = start, 0x01 = stop
  return buf;
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

// ---- Live-preview RTMP opcodes (node-osmo reference) -------------------
// Verified against datagutt/node-osmo src/device.ts for the Osmo Action 3
// flow. Action 3 skips the configure step that the Action 4/5 pipeline
// uses; we only need setupWifi → startStreaming → stopStreaming.
const SETUP_WIFI_TARGET = 0x0702;
const SETUP_WIFI_TXID   = 0x8C19;
const SETUP_WIFI_TYPE   = 0x470740;

const START_STREAM_TARGET = 0x0802;
const START_STREAM_TXID   = 0x8C2C;
const START_STREAM_TYPE   = 0x780840;

// stopStreaming reuses the same opcode triple as STOP_STREAM_* above.
// node-osmo's DjiStopStreamingMessagePayload is a fixed 6-byte blob.
const STOP_STREAM_PAYLOAD = new Uint8Array([0x01, 0x01, 0x1a, 0x00, 0x01, 0x02]);

// Resolution / fps encodings per node-osmo message.ts
const RESOLUTION_BYTE = { r480p: 0x47, r720p: 0x04, r1080p: 0x0a };
const FPS_BYTE_25 = 2;
const FPS_BYTE_30 = 3;

function buildSetupWifiPayload(ssid, password) {
  const ssidBytes = new TextEncoder().encode(ssid || '');
  const pwdBytes  = new TextEncoder().encode(password || '');
  if (ssidBytes.length > 255 || pwdBytes.length > 255) {
    throw new Error('SSID or password exceeds 255 bytes (djiPackString limit)');
  }
  const out = new Uint8Array(1 + ssidBytes.length + 1 + pwdBytes.length);
  out[0] = ssidBytes.length;
  out.set(ssidBytes, 1);
  out[1 + ssidBytes.length] = pwdBytes.length;
  out.set(pwdBytes, 2 + ssidBytes.length);
  return out;
}

function buildStartStreamPayload({ rtmpUrl, resolution = 'r720p', fps = 30, bitrateKbps = 2500 }) {
  const urlBytes = new TextEncoder().encode(rtmpUrl);
  const resByte = RESOLUTION_BYTE[resolution] || RESOLUTION_BYTE.r720p;
  const fpsByte = fps === 25 ? FPS_BYTE_25 : fps === 30 ? FPS_BYTE_30 : 0;

  // Layout (Action 3 / oa5=false):
  //   [0x00]                          payload1
  //   [0x2e]                          byte1 (0x2a if oa5)
  //   [0x00]                          payload2
  //   [resolutionByte]
  //   [bitrate LE, 2 bytes]
  //   [0x02, 0x00]                    payload3
  //   [fpsByte]
  //   [0x00, 0x00, 0x00]              payload4
  //   [url_len_lo, 0x00, ...url_utf8] djiPackUrl (2-byte length prefix)
  const head = [
    0x00,
    0x2e,
    0x00,
    resByte,
    bitrateKbps & 0xff, (bitrateKbps >> 8) & 0xff,
    0x02, 0x00,
    fpsByte,
    0x00, 0x00, 0x00,
    urlBytes.length & 0xff, (urlBytes.length >> 8) & 0xff,
  ];
  const out = new Uint8Array(head.length + urlBytes.length);
  out.set(head, 0);
  out.set(urlBytes, head.length);
  return out;
}

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

// Camera Work Mode Set — DJI DUML CmdSet 0x02 / CmdID 0x10.
// Payload byte 0: 0x00=TAKEPHOTO, 0x01=RECORD, 0x02=PLAYBACK, 0x03=TRANSCODE,
// 0x04=TUNING, 0x05=SAVEPOWER, 0x06=DOWNLOAD, 0x07=NEW_PLAYBACK.
// Source: o-gs/dji-firmware-tools dji-dumlv1-camera.lua Camera State Info
// mode enum. We send this before every record-start so the camera flips
// out of Photo mode if that's where it's sitting. Works even if the
// camera is already in RECORD mode (returns success and is a no-op).
const WORK_MODE_TARGET = 0x0102;
const WORK_MODE_TYPE   = 0x100240;
const WORK_MODE_RECORD_PAYLOAD = new Uint8Array([0x01]);

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

// ---- Protocol drivers ---------------------------------------------------
// A driver bundles the frame codec + well-known message descriptors + push
// decoder for ONE protocol dialect. CameraSession delegates to `this.driver`
// for every byte it touches. Adding a new protocol = adding a new driver
// object and teaching selectDriver() to recognize it.
//
// Interface:
//   name: string
//   sof: number                                (start-of-frame sentinel)
//   minFrameLen: number                        (shortest legal frame)
//   detect({ device }): boolean                (claim this camera?)
//   buildFrame({target,txId,type,payload}): Uint8Array
//   parseFrame(Uint8Array): { ok, target, txId, type, payload, total, reason? }
//   pairFrame(): { target, txId, type, payload, timeoutMs }
//   recordFrame('start'|'stop'): { target, txId, type, payload, timeoutMs }
//   decodePush(frame): { battery?, recording?, ... } | null
//   isRecordOk(respFrame): boolean

const dji55Driver = {
  name: 'dji-0x55',
  sof: 0x55,
  minFrameLen: 13,

  detect({ device }) {
    const n = (device?.name || '').toLowerCase();
    return /action\s*[3-5]|oa[3-5]|osmo/i.test(n);
  },

  buildFrame({ target, txId, type, payload }) {
    return buildFrame(target, txId, type, payload);
  },

  parseFrame,

  pairFrame() {
    return {
      target: PAIR_TARGET,
      txId: PAIR_TXID,
      type: PAIR_TYPE,
      payload: buildPairPayload(),
      timeoutMs: 20000,
    };
  },

  recordFrame(action) {
    return {
      target: RECORD_TARGET,
      txId: nextRecTxId(),
      type: RECORD_TYPE,
      payload: action === 'start' ? RECORD_START_PAYLOAD : RECORD_STOP_PAYLOAD,
      timeoutMs: 3000,
    };
  },

  // Sent before recordFrame('start') as a best-effort attempt to flip
  // the camera into RECORD work mode. WARNING: empirically the camera
  // doesn't respond to this frame on Action 3 firmware — it times out
  // after the brief timeout below. We still fire it in case some
  // firmwares do support it. Kept short so the record flow stays snappy.
  setWorkModeRecordFrame() {
    return {
      target: WORK_MODE_TARGET,
      txId: nextRecTxId(),
      type: WORK_MODE_TYPE,
      payload: WORK_MODE_RECORD_PAYLOAD,
      timeoutMs: 1200,
    };
  },

  // node-osmo's cleanup send: same frame shape as stopStreaming, sent
  // BEFORE setupWifi to flush any prior stream state. The camera responds
  // with the same txId even if there was nothing to stop.
  cleanupStreamFrame() {
    return {
      target: STOP_STREAM_TARGET,
      txId: STOP_STREAM_TXID,
      type: STOP_STREAM_TYPE,
      payload: STOP_STREAM_PAYLOAD,
      timeoutMs: 5000,
    };
  },

  // Transitions the camera from "cleaning up" to "ready to receive wifi
  // credentials". Must be sent between stopStreaming and setupWifi or
  // setupWifi times out. Payload is a single magic byte 0x1a per
  // node-osmo's DjiPreparingToLivestreamMessagePayload static payload —
  // NOT empty, empirically the camera returns error 0xda on an empty
  // payload and then refuses all subsequent commands.
  //
  // The camera takes 5-30s to actually transition state (it's switching
  // the whole camera into livestream mode), so the timeout is generous.
  prepareStreamFrame() {
    return {
      target: PREP_STREAM_TARGET,
      txId: PREP_STREAM_TXID,
      type: PREP_STREAM_TYPE,
      payload: new Uint8Array([0x1a]),
      timeoutMs: 30000,
    };
  },

  setupWifiFrame(ssid, password) {
    return {
      target: SETUP_WIFI_TARGET,
      txId: SETUP_WIFI_TXID,
      type: SETUP_WIFI_TYPE,
      payload: buildSetupWifiPayload(ssid, password),
      // Observed: camera spends ~30s scanning for the SSID before giving up
      // with an error, so our timeout has to clear that + a little buffer.
      timeoutMs: 45000,
    };
  },

  startStreamFrame(opts) {
    return {
      target: START_STREAM_TARGET,
      txId: START_STREAM_TXID,
      type: START_STREAM_TYPE,
      payload: buildStartStreamPayload(opts),
      timeoutMs: 30000, // camera opens RTMP TCP + handshakes with MediaMTX
    };
  },

  stopStreamFrame() {
    return {
      target: STOP_STREAM_TARGET,
      txId: STOP_STREAM_TXID,
      type: STOP_STREAM_TYPE,
      payload: STOP_STREAM_PAYLOAD,
      timeoutMs: 5000,
    };
  },

  decodePush(f) {
    if (f.target === STATUS_PUSH_TARGET && f.type === STATUS_PUSH_TYPE) {
      return parseStatusPush(f.payload);
    }
    return null;
  },

  isRecordOk(resp) {
    return resp.payload.length >= 1 && resp.payload[0] === 0x00;
  },
};

// Placeholder for the rhoenschrat / DJI-SDK 0xAA protocol. The Action 4 may
// or may not speak this — unknown until hardware arrives. Every method
// throws until the user captures real bytes and we fill it in.
const NOT_IMPL = () => { throw new Error('0xAA driver not implemented; waiting on Action 4 capture'); };
const dji0xaaDriver = {
  name: 'dji-0xaa',
  sof: 0xAA,
  minFrameLen: 13, // placeholder; actual value TBD from capture

  detect({ device }) {
    const n = (device?.name || '').toLowerCase();
    return /action\s*4|oa4/.test(n);
  },

  buildFrame: NOT_IMPL,
  parseFrame: NOT_IMPL,
  pairFrame: NOT_IMPL,
  recordFrame: NOT_IMPL,
  setupWifiFrame: NOT_IMPL,
  startStreamFrame: NOT_IMPL,
  stopStreamFrame: NOT_IMPL,
  decodePush() { return null; },
  isRecordOk() { return false; },
};

const DRIVERS = [dji55Driver];

function selectDriver({ device }) {
  for (const d of DRIVERS) {
    if (d.detect({ device })) return d;
  }
  // Safe default: the Action 3 path is known-working, so an unknown camera
  // gets 0x55 by default. If handshake fails with a CRC error we'll know to
  // try 0xAA instead once it's implemented.
  return dji55Driver;
}

// ---- DJIControl class ---------------------------------------------------
export class DJIControl extends EventTarget {
  constructor() {
    super();
    /** @type {Map<string, CameraSession>} */
    this.pairedCameras = new Map();
    this.transport = selectTransport();
    this._transportReady = null;
  }

  isSupported() {
    // True if either transport can work in this environment.
    if (typeof window === 'undefined') return false;
    if (window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()) return true;
    return 'bluetooth' in navigator;
  }

  log(kind, msg) { this.dispatchEvent(new CustomEvent('log', { detail: { kind, msg } })); }

  _emitStatus(session) {
    this.dispatchEvent(new CustomEvent('statusChange', { detail: { session } }));
  }

  async _ensureTransport() {
    if (!this._transportReady) {
      this._transportReady = this.transport.initialize().catch((e) => {
        this._transportReady = null;
        throw e;
      });
    }
    return this._transportReady;
  }

  async scanAndPair() {
    if (!this.isSupported()) throw new Error('BLE not available. Use Chrome on Android over HTTPS/localhost, or the APK build.');
    await this._ensureTransport();

    const handle = await this.transport.requestDevice({
      optionalServices: [DJI_SERVICE, 'battery_service'],
    });

    const session = await this._bringUpSession(handle);
    // On successful pair, remember this device so we can auto-reconnect
    // next time the app opens without the picker.
    this._rememberDevice(handle);
    return session;
  }

  // Auto-pair with the device saved from the last successful pair. No
  // picker — goes straight through the transport's getKnownDevice(...)
  // helper. Called on app startup; silently no-ops if nothing's saved
  // or the device isn't reachable.
  async autoPairLast() {
    if (!this.isSupported()) return null;
    const saved = this._getRememberedDevice();
    if (!saved) return null;
    try {
      await this._ensureTransport();
      if (typeof this.transport.getKnownDevice !== 'function') {
        this.log('warn', `Auto-pair unsupported on ${this.transport.name} transport`);
        return null;
      }
      this.log('ok', `Auto-pairing saved device ${saved.name || saved.deviceId}…`);
      const handle = await this.transport.getKnownDevice(saved);
      return await this._bringUpSession(handle);
    } catch (e) {
      this.log('warn', `Auto-pair failed: ${e.message}. Tap Pair to reconnect.`);
      return null;
    }
  }

  forgetLastDevice() {
    try { localStorage.removeItem('fmc-last-paired'); } catch {}
    this.log('ok', 'Forgot saved pairing.');
  }

  _rememberDevice(handle) {
    try {
      localStorage.setItem('fmc-last-paired', JSON.stringify({
        deviceId: handle.id || handle.deviceId,
        name: handle.name || null,
      }));
    } catch {}
  }

  _getRememberedDevice() {
    try {
      const raw = localStorage.getItem('fmc-last-paired');
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || !parsed.deviceId) return null;
      return parsed;
    } catch { return null; }
  }

  // Shared pair flow for fresh requestDevice() picks and auto-pair.
  async _bringUpSession(handle) {
    const driver = selectDriver({ device: { name: handle.name } });
    this.log('ok', `Selected ${handle.name || handle.id}. Transport: ${this.transport.name}. Driver: ${driver.name}. Connecting GATT…`);

    const session = new CameraSession(handle, this, driver, this.transport);
    this.pairedCameras.set(handle.id, session);
    this._emitStatus(session);

    try {
      await session.connect();
      await session.handshake();
      this.log('ok', `Handshake complete with ${handle.name || handle.id}`);
    } catch (e) {
      this.log('err', `Pairing failed for ${handle.name || handle.id}: ${e.message}`);
      session.intentionalDisconnect = true; // prevent auto-reconnect on a failed first pair
      this.pairedCameras.delete(handle.id);
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
    s.intentionalDisconnect = true;
    s._cancelReconnect();
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
    return Promise.all(sessions.map(async (s) => {
      try {
        if (s._recordProtocol === 'aa') {
          return await this._recordViaAA(s, action);
        }
        // Try 0x55 first (works for Action 3)
        try {
          const timeout = s._recordProtocol === '55' ? 3000 : 1500;
          const resp = await s.sendAndAwait({ ...s.driver.recordFrame(action), timeoutMs: timeout });
          if (!s.driver.isRecordOk(resp)) {
            const status = resp.payload[0];
            let hint = '';
            if (status === 0xdf) {
              hint = ' — camera may be in Photo mode. Switch to Video on the camera body.';
            }
            throw new Error(`camera returned error 0x${status?.toString(16)}${hint}`);
          }
          s._recordProtocol = '55';
          s.recording = (action === 'start');
          this._emitStatus(s);
          return { ok: true, session: s };
        } catch (e) {
          if (s._recordProtocol === '55') throw e;
          this.log('warn', `${s.label()} 0x55 record failed (${e.message}), trying 0xAA…`);
        }
        return await this._recordViaAA(s, action);
      } catch (e) {
        return { ok: false, session: s, err: e };
      }
    }));
  }

  async _recordViaAA(s, action) {
    const seq = nextAASeq();
    const resp = await s.sendAAAndAwait({
      seq,
      cmdSet: AA_REC_CMDSET,
      cmdId: AA_REC_CMDID,
      payload: buildAARecordPayload(action === 'start'),
      timeoutMs: 5000,
    });
    if (resp.payload.length >= 1 && resp.payload[0] !== 0x00) {
      throw new Error(`0xAA record error: ret_code=0x${resp.payload[0].toString(16)}`);
    }
    s._recordProtocol = 'aa';
    s.recording = (action === 'start');
    this._emitStatus(s);
    return { ok: true, session: s };
  }

  // ---- Live preview (RTMP) fan-out ------------------------------------
  // For each connected camera, send setupWifi then startStreaming. The
  // cameras are given distinct RTMP paths (cam1, cam2, ...) under a
  // common baseUrl so our on-device MediaMTX can distinguish them.
  async startPreviewAll({ ssid, password, baseRtmpUrl, resolution, fps, bitrateKbps }) {
    const sessions = Array.from(this.pairedCameras.values()).filter(s => s.connected);
    if (sessions.length === 0) throw new Error('No connected cameras');
    // Per node-osmo's osmoAction3 state machine, we must walk the full
    // cleanup → prepare → wifi → start sequence. Each step awaits its
    // response before the next. Skipping stopStream or prepareStream
    // causes setupWifi to silently time out (camera ignores it if it's
    // not in the right state).
    // Helper: await a frame, verify the response indicates success. Camera
    // responses use payload[0] as a status byte — 0x00 = success, anything
    // else is an error code we should surface with context instead of
    // plowing ahead into the next step.
    const step = async (s, label, frame) => {
      this.log('ok', `${s.label()} → ${label}`);
      const resp = await s.sendAndAwait(frame);
      const status = resp.payload.length ? resp.payload[0] : 0;
      if (status !== 0x00) {
        const hexPayload = Array.from(resp.payload).map(b => b.toString(16).padStart(2, '0')).join(' ');
        throw new Error(`${label} rejected by camera (status 0x${status.toString(16)}, full payload: ${hexPayload})`);
      }
      return resp;
    };

    return Promise.all(sessions.map(async (s, i) => {
      const rtmpUrl = `${baseRtmpUrl}/cam${i + 1}`;
      try {
        await step(s, 'stopStreaming (cleanup)', s.driver.cleanupStreamFrame());
        await step(s, 'preparingToLivestream', s.driver.prepareStreamFrame());
        await step(s, `setupWifi "${ssid}" (ensure hotspot is 2.4 GHz — Action 3 does not support 5 GHz)`, s.driver.setupWifiFrame(ssid, password));
        await step(s, `startStreaming ${rtmpUrl}`, s.driver.startStreamFrame({ rtmpUrl, resolution, fps, bitrateKbps }));
        s.streaming = true;
        s.streamUrl = rtmpUrl;
        this._emitStatus(s);
        return { ok: true, session: s, rtmpUrl };
      } catch (e) {
        this.log('err', `${s.label()} preview failed: ${e.message}`);
        return { ok: false, session: s, err: e };
      }
    }));
  }

  async stopPreviewAll() {
    const sessions = Array.from(this.pairedCameras.values()).filter(s => s.connected);
    return Promise.all(sessions.map(async (s) => {
      try {
        await s.sendAndAwait(s.driver.stopStreamFrame());
        s.streaming = false;
        s.streamUrl = null;
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
  // Reconnect backoff in ms. Last value repeats indefinitely.
  // Field use case: 60-90 min soccer matches, cameras may drop and come back
  // minutes later when a player runs by the tripod. We want to self-heal
  // without the coach having to notice, so there's no retry cap.
  static BACKOFF_MS = [0, 2000, 5000, 15000, 30000, 60000];

  constructor(handle, control, driver, transport) {
    this.handle = handle;          // opaque transport handle
    this.device = handle;          // kept for backward-compat in app.js chip render
    this.control = control;
    this.driver = driver;
    this.transport = transport;
    this.connected = false;
    this.recording = false;
    this.streaming = false;
    this.streamUrl = null;
    this.battery = null;
    this.rxBuffer = new Uint8Array(0);
    this.pendingByTxId = new Map(); // txId -> { resolve, reject, timer }
    this.intentionalDisconnect = false;
    this.reconnecting = false;
    this.reconnectAttempt = 0;
    this._reconnectTimer = null;
    this._recordProtocol = null; // null = unknown, '55' or 'aa'
    this.onGattDisconnected = this.onGattDisconnected.bind(this);
  }

  label() { return this.handle.name || this.handle.id || 'camera'; }

  onGattDisconnected() {
    this.connected = false;
    this._clearPending('GATT disconnected');
    this.rxBuffer = new Uint8Array(0);
    this.control.log('warn', `${this.label()} disconnected`);
    this.control._emitStatus(this);
    if (this.intentionalDisconnect) return;
    // session.recording is intentionally NOT cleared — the camera keeps
    // recording to SD across a BLE drop, so the flag stays true and we
    // won't re-send a start on reconnect.
    this._scheduleReconnect();
  }

  _clearPending(reason) {
    for (const [, w] of this.pendingByTxId) {
      clearTimeout(w.timer);
      w.reject(new Error(reason));
    }
    this.pendingByTxId.clear();
  }

  _cancelReconnect() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this.reconnecting = false;
    this.reconnectAttempt = 0;
  }

  _scheduleReconnect() {
    if (this.reconnecting) return;
    this.reconnecting = true;
    this.reconnectAttempt = 0;
    this._tryReconnect();
  }

  // Web Bluetooth gotcha: the same BluetoothDevice object retains its user
  // permission across GATT disconnects as long as the session is held in
  // pairedCameras and the tab stays foregrounded — no re-prompt needed.
  // Android Chrome occasionally throws NetworkError on a first retry; the
  // backoff schedule absorbs that.
  _tryReconnect() {
    if (this.intentionalDisconnect) { this._cancelReconnect(); return; }
    const i = Math.min(this.reconnectAttempt, CameraSession.BACKOFF_MS.length - 1);
    const delay = CameraSession.BACKOFF_MS[i];
    this.reconnectAttempt++;
    this.control.log('warn', `Reconnect attempt ${this.reconnectAttempt} for ${this.label()} in ${delay}ms`);
    this.control._emitStatus(this);
    this._reconnectTimer = setTimeout(async () => {
      this._reconnectTimer = null;
      if (this.intentionalDisconnect) return;
      try {
        await this.connect();
        await this.handshake();
        this.control.log('ok', `Reconnected ${this.label()}`);
        this._cancelReconnect();
        this.control._emitStatus(this);
      } catch (e) {
        this.control.log('err', `Reconnect failed for ${this.label()}: ${e.message}`);
        this._tryReconnect();
      }
    }, delay);
  }

  async connect() {
    await this.transport.connect(this.handle, { onDisconnect: this.onGattDisconnected });

    const onRx = (dv) => this.onNotification(dv);
    await this.transport.startNotifications(this.handle, DJI_SERVICE, DJI_CHAR_NOTIFY, onRx);
    try {
      await this.transport.startNotifications(this.handle, DJI_SERVICE, DJI_CHAR_NOTIFY2, onRx);
    } catch {
      // fff5 may not exist on some firmwares; non-fatal.
    }

    this.connected = true;
    this.control.log('ok', `GATT connected via ${this.transport.name}, notifications active`);
  }

  disconnect() {
    try { this.transport.disconnect(this.handle); } catch {}
    this.connected = false;
  }

  onNotification(dv) {
    const incoming = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
    const merged = new Uint8Array(this.rxBuffer.length + incoming.length);
    merged.set(this.rxBuffer, 0);
    merged.set(incoming, this.rxBuffer.length);
    this.rxBuffer = merged;

    while (this.rxBuffer.length >= 4) {
      const sof = this.rxBuffer[0];
      if (sof === 0x55) {
        if (this.rxBuffer.length < 13) return;
        const totalLen = this.rxBuffer[1];
        if (totalLen < 13) { this.rxBuffer = this.rxBuffer.slice(1); continue; }
        if (this.rxBuffer.length < totalLen) return;
        const frame = this.rxBuffer.slice(0, totalLen);
        this.rxBuffer = this.rxBuffer.slice(totalLen);
        const parsed = this.driver.parseFrame(frame);
        if (!parsed.ok) {
          this.control.log('warn', `frame parse error: ${parsed.reason} raw=${hex(frame)}`);
          continue;
        }
        this.dispatchFrame(parsed);
      } else if (sof === 0xAA) {
        if (this.rxBuffer.length < 3) return;
        const totalLen = (this.rxBuffer[1] | (this.rxBuffer[2] << 8)) & 0x3FF;
        if (totalLen < 16) { this.rxBuffer = this.rxBuffer.slice(1); continue; }
        if (this.rxBuffer.length < totalLen) return;
        const frame = this.rxBuffer.slice(0, totalLen);
        this.rxBuffer = this.rxBuffer.slice(totalLen);
        const parsed = parseAAFrame(frame);
        if (!parsed.ok) {
          this.control.log('warn', `0xAA frame parse error: ${parsed.reason}`);
          continue;
        }
        this.dispatchAAFrame(parsed);
      } else {
        const i55 = this.rxBuffer.indexOf(0x55);
        const iAA = this.rxBuffer.indexOf(0xAA);
        const next = i55 >= 0 && iAA >= 0 ? Math.min(i55, iAA)
                   : i55 >= 0 ? i55 : iAA >= 0 ? iAA : -1;
        if (next < 0) { this.rxBuffer = new Uint8Array(0); return; }
        this.rxBuffer = this.rxBuffer.slice(next);
      }
    }
  }

  dispatchFrame(f) {
    // Let the driver decode any status push it recognizes. Return null means
    // "not a push, fall through to normal reply routing".
    const push = this.driver.decodePush(f);
    if (push) {
      if (typeof push.battery === 'number' && push.battery !== this.battery) {
        this.battery = push.battery;
        this.control.log('ok', `${this.label()} batt=${push.battery}%`);
        this.control._emitStatus(this);
      }
      return; // suppress raw log — pushes arrive ~1 Hz
    }

    this.control.log('ok', `⇐ target=0x${f.target.toString(16)} txId=0x${f.txId.toString(16)} type=0x${f.type.toString(16)} payload=${hex(f.payload)}`);
    const waiter = this.pendingByTxId.get(f.txId);
    if (waiter) {
      clearTimeout(waiter.timer);
      this.pendingByTxId.delete(f.txId);
      waiter.resolve(f);
    }
  }

  dispatchAAFrame(f) {
    this.control.log('ok', `⇐ [0xAA] seq=0x${f.seq.toString(16)} cmd=${f.cmdSet}/${f.cmdId} resp=${f.isResponse} payload=${hex(f.payload)}`);
    const waiter = this.pendingByTxId.get(f.seq);
    if (waiter) {
      clearTimeout(waiter.timer);
      this.pendingByTxId.delete(f.seq);
      waiter.resolve(f);
    }
  }

  async sendAAAndAwait({ seq, cmdSet, cmdId, payload, timeoutMs = 5000 }) {
    const frame = buildAAFrame(seq, cmdSet, cmdId, payload);
    this.control.log('ok', `⇒ [0xAA] seq=0x${seq.toString(16)} cmd=${cmdSet}/${cmdId} payload=${hex(payload)} [${frame.length}B]`);
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingByTxId.delete(seq);
        reject(new Error(`Timeout awaiting 0xAA response for seq=0x${seq.toString(16)}`));
      }, timeoutMs);
      this.pendingByTxId.set(seq, { resolve, reject, timer });
    });
    try {
      await this.transport.writeWithoutResponse(this.handle, DJI_SERVICE, DJI_CHAR_WRITE, frame);
    } catch (e) {
      this.pendingByTxId.delete(seq);
      throw new Error(`write failed: ${e.message}`);
    }
    return promise;
  }

  async sendAndAwait({ target, txId, type, payload, timeoutMs = 5000 }) {
    const frame = this.driver.buildFrame({ target, txId, type, payload });
    this.control.log('ok', `⇒ target=0x${target.toString(16)} txId=0x${txId.toString(16)} type=0x${type.toString(16)} payload=${hex(payload)} [${frame.length}B]`);

    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingByTxId.delete(txId);
        reject(new Error(`Timeout awaiting response for txId=0x${txId.toString(16)}`));
      }, timeoutMs);
      this.pendingByTxId.set(txId, { resolve, reject, timer });
    });

    try {
      await this.transport.writeWithoutResponse(this.handle, DJI_SERVICE, DJI_CHAR_WRITE, frame);
    } catch (e) {
      this.pendingByTxId.delete(txId);
      throw new Error(`write failed: ${e.message}`);
    }

    return promise;
  }

  async handshake() {
    // Delegated to the driver so the Action 4 can supply a different pair
    // message shape if needed. For 0x55, ANY response on the correct txId
    // is a success (payload [0x00, 0x01] = "already paired").
    const resp = await this.sendAndAwait(this.driver.pairFrame());
    this.control.log('ok', `Pair response: ${hex(resp.payload)}`);
  }
}

function hex(bytes) {
  if (!bytes || !bytes.length) return '';
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(' ');
}
