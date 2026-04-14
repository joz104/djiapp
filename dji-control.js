// DJIControl — Web Bluetooth control for DJI Osmo Action cameras.
//
// Implements the "DJI R-SDK / GPS Remote" protocol (SOF 0xAA, CmdSet/CmdID).
// This is the same protocol that the official DJI Osmo GPS Remote speaks, and
// it's what you need to start/stop SD-card recording. Ported from:
//   - rhoenschrat/DJI-Remote (ESP-IDF / C) — command logic, pair flow, CRCs
//   - dji-sdk/Osmo-GPS-Controller-Demo       — frame layout confirmation
//
// FRAME LAYOUT (all multibyte little-endian):
//   off  size  field
//    0    1    SOF = 0xAA
//    1    2    Ver/Length (low 10 bits = total frame length, high 6 = ver=0)
//    3    1    CmdType (0x00=no-response, 0x02=wait-result, 0x20=ack-no-response)
//    4    1    ENC = 0x00
//    5    3    RES[3] = 00 00 00
//    8    2    SEQ (monotonic u16)
//   10    2    CRC16 over bytes[0..9]   (init 0x3AA3, reflected CRC-16/IBM)
//   12    1    CmdSet
//   13    1    CmdID
//   14    N    DATA (packed struct bytes)
//   14+N  4    CRC32 over bytes[0..13+N] (init 0x3AA3, reflected CRC-32, no xorout)

// ---- BLE UUIDs ----------------------------------------------------------
const DJI_SERVICE     = '0000fff0-0000-1000-8000-00805f9b34fb';
const DJI_CHAR_WRITE  = '0000fff3-0000-1000-8000-00805f9b34fb'; // we write here
const DJI_CHAR_NOTIFY = '0000fff4-0000-1000-8000-00805f9b34fb'; // camera notifies here
const DJI_CHAR_NOTIFY2 = '0000fff5-0000-1000-8000-00805f9b34fb'; // sometimes used too

// ---- CRC16 (CRC-16/IBM reflected, init 0x3AA3) --------------------------
const CRC16_TABLE = new Uint16Array([
  0x0000, 0xc0c1, 0xc181, 0x0140, 0xc301, 0x03c0, 0x0280, 0xc241,
  0xc601, 0x06c0, 0x0780, 0xc741, 0x0500, 0xc5c1, 0xc481, 0x0440,
  0xcc01, 0x0cc0, 0x0d80, 0xcd41, 0x0f00, 0xcfc1, 0xce81, 0x0e40,
  0x0a00, 0xcac1, 0xcb81, 0x0b40, 0xc901, 0x09c0, 0x0880, 0xc841,
  0xd801, 0x18c0, 0x1980, 0xd941, 0x1b00, 0xdbc1, 0xda81, 0x1a40,
  0x1e00, 0xdec1, 0xdf81, 0x1f40, 0xdd01, 0x1dc0, 0x1c80, 0xdc41,
  0x1400, 0xd4c1, 0xd581, 0x1540, 0xd701, 0x17c0, 0x1680, 0xd641,
  0xd201, 0x12c0, 0x1380, 0xd341, 0x1100, 0xd1c1, 0xd081, 0x1040,
  0xf001, 0x30c0, 0x3180, 0xf141, 0x3300, 0xf3c1, 0xf281, 0x3240,
  0x3600, 0xf6c1, 0xf781, 0x3740, 0xf501, 0x35c0, 0x3480, 0xf441,
  0x3c00, 0xfcc1, 0xfd81, 0x3d40, 0xff01, 0x3fc0, 0x3e80, 0xfe41,
  0xfa01, 0x3ac0, 0x3b80, 0xfb41, 0x3900, 0xf9c1, 0xf881, 0x3840,
  0x2800, 0xe8c1, 0xe981, 0x2940, 0xeb01, 0x2bc0, 0x2a80, 0xea41,
  0xee01, 0x2ec0, 0x2f80, 0xef41, 0x2d00, 0xedc1, 0xec81, 0x2c40,
  0xe401, 0x24c0, 0x2580, 0xe541, 0x2700, 0xe7c1, 0xe681, 0x2640,
  0x2200, 0xe2c1, 0xe381, 0x2340, 0xe101, 0x21c0, 0x2080, 0xe041,
  0xa001, 0x60c0, 0x6180, 0xa141, 0x6300, 0xa3c1, 0xa281, 0x6240,
  0x6600, 0xa6c1, 0xa781, 0x6740, 0xa501, 0x65c0, 0x6480, 0xa441,
  0x6c00, 0xacc1, 0xad81, 0x6d40, 0xaf01, 0x6fc0, 0x6e80, 0xae41,
  0xaa01, 0x6ac0, 0x6b80, 0xab41, 0x6900, 0xa9c1, 0xa881, 0x6840,
  0x7800, 0xb8c1, 0xb981, 0x7940, 0xbb01, 0x7bc0, 0x7a80, 0xba41,
  0xbe01, 0x7ec0, 0x7f80, 0xbf41, 0x7d00, 0xbdc1, 0xbc81, 0x7c40,
  0xb401, 0x74c0, 0x7580, 0xb541, 0x7700, 0xb7c1, 0xb681, 0x7640,
  0x7200, 0xb2c1, 0xb381, 0x7340, 0xb101, 0x71c0, 0x7080, 0xb041,
  0x5000, 0x90c1, 0x9181, 0x5140, 0x9301, 0x53c0, 0x5280, 0x9241,
  0x9601, 0x56c0, 0x5780, 0x9741, 0x5500, 0x95c1, 0x9481, 0x5440,
  0x9c01, 0x5cc0, 0x5d80, 0x9d41, 0x5f00, 0x9fc1, 0x9e81, 0x5e40,
  0x5a00, 0x9ac1, 0x9b81, 0x5b40, 0x9901, 0x59c0, 0x5880, 0x9841,
  0x8801, 0x48c0, 0x4980, 0x8941, 0x4b00, 0x8bc1, 0x8a81, 0x4a40,
  0x4e00, 0x8ec1, 0x8f81, 0x4f40, 0x8d01, 0x4dc0, 0x4c80, 0x8c41,
  0x4400, 0x84c1, 0x8581, 0x4540, 0x8701, 0x47c0, 0x4680, 0x8641,
  0x8201, 0x42c0, 0x4380, 0x8341, 0x4100, 0x81c1, 0x8081, 0x4040,
]);

function crc16(bytes) {
  let crc = 0x3AA3;
  for (let i = 0; i < bytes.length; i++) {
    crc = (CRC16_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)) & 0xffff;
  }
  return crc;
}

// ---- CRC32 (CRC-32 reflected, init 0x3AA3, no xorout) -------------------
const CRC32_TABLE = new Uint32Array([
  0x00000000, 0x77073096, 0xee0e612c, 0x990951ba, 0x076dc419, 0x706af48f, 0xe963a535, 0x9e6495a3,
  0x0edb8832, 0x79dcb8a4, 0xe0d5e91e, 0x97d2d988, 0x09b64c2b, 0x7eb17cbd, 0xe7b82d07, 0x90bf1d91,
  0x1db71064, 0x6ab020f2, 0xf3b97148, 0x84be41de, 0x1adad47d, 0x6ddde4eb, 0xf4d4b551, 0x83d385c7,
  0x136c9856, 0x646ba8c0, 0xfd62f97a, 0x8a65c9ec, 0x14015c4f, 0x63066cd9, 0xfa0f3d63, 0x8d080df5,
  0x3b6e20c8, 0x4c69105e, 0xd56041e4, 0xa2677172, 0x3c03e4d1, 0x4b04d447, 0xd20d85fd, 0xa50ab56b,
  0x35b5a8fa, 0x42b2986c, 0xdbbbc9d6, 0xacbcf940, 0x32d86ce3, 0x45df5c75, 0xdcd60dcf, 0xabd13d59,
  0x26d930ac, 0x51de003a, 0xc8d75180, 0xbfd06116, 0x21b4f4b5, 0x56b3c423, 0xcfba9599, 0xb8bda50f,
  0x2802b89e, 0x5f058808, 0xc60cd9b2, 0xb10be924, 0x2f6f7c87, 0x58684c11, 0xc1611dab, 0xb6662d3d,
  0x76dc4190, 0x01db7106, 0x98d220bc, 0xefd5102a, 0x71b18589, 0x06b6b51f, 0x9fbfe4a5, 0xe8b8d433,
  0x7807c9a2, 0x0f00f934, 0x9609a88e, 0xe10e9818, 0x7f6a0dbb, 0x086d3d2d, 0x91646c97, 0xe6635c01,
  0x6b6b51f4, 0x1c6c6162, 0x856530d8, 0xf262004e, 0x6c0695ed, 0x1b01a57b, 0x8208f4c1, 0xf50fc457,
  0x65b0d9c6, 0x12b7e950, 0x8bbeb8ea, 0xfcb9887c, 0x62dd1ddf, 0x15da2d49, 0x8cd37cf3, 0xfbd44c65,
  0x4db26158, 0x3ab551ce, 0xa3bc0074, 0xd4bb30e2, 0x4adfa541, 0x3dd895d7, 0xa4d1c46d, 0xd3d6f4fb,
  0x4369e96a, 0x346ed9fc, 0xad678846, 0xda60b8d0, 0x44042d73, 0x33031de5, 0xaa0a4c5f, 0xdd0d7cc9,
  0x5005713c, 0x270241aa, 0xbe0b1010, 0xc90c2086, 0x5768b525, 0x206f85b3, 0xb966d409, 0xce61e49f,
  0x5edef90e, 0x29d9c998, 0xb0d09822, 0xc7d7a8b4, 0x59b33d17, 0x2eb40d81, 0xb7bd5c3b, 0xc0ba6cad,
  0xedb88320, 0x9abfb3b6, 0x03b6e20c, 0x74b1d29a, 0xead54739, 0x9dd277af, 0x04db2615, 0x73dc1683,
  0xe3630b12, 0x94643b84, 0x0d6d6a3e, 0x7a6a5aa8, 0xe40ecf0b, 0x9309ff9d, 0x0a00ae27, 0x7d079eb1,
  0xf00f9344, 0x8708a3d2, 0x1e01f268, 0x6906c2fe, 0xf762575d, 0x806567cb, 0x196c3671, 0x6e6b06e7,
  0xfed41b76, 0x89d32be0, 0x10da7a5a, 0x67dd4acc, 0xf9b9df6f, 0x8ebeeff9, 0x17b7be43, 0x60b08ed5,
  0xd6d6a3e8, 0xa1d1937e, 0x38d8c2c4, 0x4fdff252, 0xd1bb67f1, 0xa6bc5767, 0x3fb506dd, 0x48b2364b,
  0xd80d2bda, 0xaf0a1b4c, 0x36034af6, 0x41047a60, 0xdf60efc3, 0xa867df55, 0x316e8eef, 0x4669be79,
  0xcb61b38c, 0xbc66831a, 0x256fd2a0, 0x5268e236, 0xcc0c7795, 0xbb0b4703, 0x220216b9, 0x5505262f,
  0xc5ba3bbe, 0xb2bd0b28, 0x2bb45a92, 0x5cb36a04, 0xc2d7ffa7, 0xb5d0cf31, 0x2cd99e8b, 0x5bdeae1d,
  0x9b64c2b0, 0xec63f226, 0x756aa39c, 0x026d930a, 0x9c0906a9, 0xeb0e363f, 0x72076785, 0x05005713,
  0x95bf4a82, 0xe2b87a14, 0x7bb12bae, 0x0cb61b38, 0x92d28e9b, 0xe5d5be0d, 0x7cdcefb7, 0x0bdbdf21,
  0x86d3d2d4, 0xf1d4e242, 0x68ddb3f8, 0x1fda836e, 0x81be16cd, 0xf6b9265b, 0x6fb077e1, 0x18b74777,
  0x88085ae6, 0xff0f6a70, 0x66063bca, 0x11010b5c, 0x8f659eff, 0xf862ae69, 0x616bffd3, 0x166ccf45,
  0xa00ae278, 0xd70dd2ee, 0x4e048354, 0x3903b3c2, 0xa7672661, 0xd06016f7, 0x4969474d, 0x3e6e77db,
  0xaed16a4a, 0xd9d65adc, 0x40df0b66, 0x37d83bf0, 0xa9bcae53, 0xdebb9ec5, 0x47b2cf7f, 0x30b5ffe9,
  0xbdbdf21c, 0xcabac28a, 0x53b39330, 0x24b4a3a6, 0xbad03605, 0xcdd70693, 0x54de5729, 0x23d967bf,
  0xb3667a2e, 0xc4614ab8, 0x5d681b02, 0x2a6f2b94, 0xb40bbe37, 0xc30c8ea1, 0x5a05df1b, 0x2d02ef8d,
]);

function crc32(bytes) {
  let crc = 0x00003AA3;
  for (let i = 0; i < bytes.length; i++) {
    crc = (CRC32_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)) >>> 0;
  }
  return crc >>> 0;
}

// ---- Frame builder/parser -----------------------------------------------
export const CMD_NO_RESPONSE     = 0x00;
export const CMD_RESPONSE_OR_NOT = 0x01;
export const CMD_WAIT_RESULT     = 0x02;
export const ACK_NO_RESPONSE     = 0x20;
export const ACK_RESPONSE_OR_NOT = 0x21;
export const ACK_WAIT_RESULT     = 0x22;

function buildFrame(cmdSet, cmdId, cmdType, data, seq) {
  const dataLen = data.length;
  const total = 14 + dataLen + 4; // header + data + crc32
  if (total > 0x3FF) throw new Error('DJI frame too large (>1023 bytes)');

  const out = new Uint8Array(total);
  out[0] = 0xAA;
  const verLength = total & 0x3FF; // version=0 in high 6 bits
  out[1] = verLength & 0xFF;
  out[2] = (verLength >> 8) & 0xFF;
  out[3] = cmdType;
  out[4] = 0x00;              // ENC
  out[5] = out[6] = out[7] = 0x00; // RES[3]
  out[8] = seq & 0xFF;
  out[9] = (seq >> 8) & 0xFF;

  const headerCrc = crc16(out.subarray(0, 10));
  out[10] = headerCrc & 0xFF;
  out[11] = (headerCrc >> 8) & 0xFF;

  out[12] = cmdSet;
  out[13] = cmdId;
  out.set(data, 14);

  const fullCrc = crc32(out.subarray(0, 14 + dataLen));
  const off = 14 + dataLen;
  out[off] = fullCrc & 0xFF;
  out[off + 1] = (fullCrc >> 8) & 0xFF;
  out[off + 2] = (fullCrc >> 16) & 0xFF;
  out[off + 3] = (fullCrc >> 24) & 0xFF;
  return out;
}

function parseFrame(bytes) {
  if (bytes.length < 18) return { ok: false, reason: 'too short' };
  if (bytes[0] !== 0xAA) return { ok: false, reason: `bad SOF 0x${bytes[0].toString(16)}` };
  const verLength = bytes[1] | (bytes[2] << 8);
  const total = verLength & 0x3FF;
  if (bytes.length < total) return { ok: false, reason: `short frame: need ${total}, have ${bytes.length}` };
  const cmdType = bytes[3];
  const seq = bytes[8] | (bytes[9] << 8);
  const headerCrc = bytes[10] | (bytes[11] << 8);
  const calcHeader = crc16(bytes.subarray(0, 10));
  if (headerCrc !== calcHeader) return { ok: false, reason: `crc16 mismatch got=${headerCrc.toString(16)} calc=${calcHeader.toString(16)}` };
  const cmdSet = bytes[12];
  const cmdId = bytes[13];
  const dataLen = total - 14 - 4;
  const data = bytes.subarray(14, 14 + dataLen);
  const trailCrcOff = 14 + dataLen;
  const trailCrc = bytes[trailCrcOff] | (bytes[trailCrcOff + 1] << 8)
                 | (bytes[trailCrcOff + 2] << 16) | (bytes[trailCrcOff + 3] << 24);
  const calcTrail = crc32(bytes.subarray(0, trailCrcOff));
  if ((trailCrc >>> 0) !== (calcTrail >>> 0)) {
    return { ok: false, reason: `crc32 mismatch got=${(trailCrc >>> 0).toString(16)} calc=${(calcTrail >>> 0).toString(16)}` };
  }
  return { ok: true, cmdType, seq, cmdSet, cmdId, data, total };
}

// ---- Payload builders ---------------------------------------------------

// connection_request_command_frame: 33 bytes packed
//   u32 device_id, u8 mac_addr_len, i8 mac_addr[16], u32 fw_version,
//   u8 conidx, u8 verify_mode, u16 verify_data, u8 reserved[4]
function buildConnectionRequest({ deviceId, macAddr, fwVersion, verifyMode, verifyData }) {
  const buf = new Uint8Array(33);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, deviceId, true);
  buf[4] = 6;                            // mac_addr_len
  for (let i = 0; i < 6; i++) buf[5 + i] = macAddr[i];
  // mac_addr[6..15] already zero
  dv.setUint32(21, fwVersion, true);
  buf[25] = 0;                           // conidx
  buf[26] = verifyMode;
  dv.setUint16(27, verifyData, true);
  // reserved[29..32] already zero
  return buf;
}

// connection_request_response_frame: 9 bytes
//   u32 device_id, u8 ret_code, u8 reserved[4]
function buildConnectionResponse({ deviceId, retCode = 0, cameraReserved = 0 }) {
  const buf = new Uint8Array(9);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, deviceId, true);
  buf[4] = retCode;
  buf[5] = cameraReserved;
  return buf;
}

// record_control_command_frame_t: 9 bytes
//   u32 device_id, u8 record_ctrl (0=start,1=stop), u8 reserved[4]
function buildRecordControl({ deviceId, start }) {
  const buf = new Uint8Array(9);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, deviceId, true);
  buf[4] = start ? 0x00 : 0x01;
  return buf;
}

// ---- Identity persistence ----------------------------------------------
// Each tablet has one identity (device_id + mac) that it uses to pair with
// every camera. We persist it in localStorage so subsequent sessions can
// reconnect without re-triggering the "new remote" confirmation on the camera.
function getOrCreateIdentity() {
  const KEY = 'fieldcam.identity.v1';
  try {
    const stored = localStorage.getItem(KEY);
    if (stored) return JSON.parse(stored);
  } catch {}
  // New identity: random 32-bit device_id and 6-byte "mac address"
  const rnd = crypto.getRandomValues(new Uint8Array(10));
  const dv = new DataView(rnd.buffer);
  const identity = {
    deviceId: dv.getUint32(0, true),
    macAddr: Array.from(rnd.subarray(4, 10)),
    fwVersion: 0,
  };
  try { localStorage.setItem(KEY, JSON.stringify(identity)); } catch {}
  return identity;
}

// Per-camera pairing state (keyed by camera's BLE device.id)
function loadCameraRecord(deviceId) {
  try {
    const all = JSON.parse(localStorage.getItem('fieldcam.cameras.v1') || '{}');
    return all[deviceId] || null;
  } catch { return null; }
}
function saveCameraRecord(deviceId, record) {
  try {
    const all = JSON.parse(localStorage.getItem('fieldcam.cameras.v1') || '{}');
    all[deviceId] = record;
    localStorage.setItem('fieldcam.cameras.v1', JSON.stringify(all));
  } catch {}
}

// ---- DJIControl class ---------------------------------------------------
export class DJIControl extends EventTarget {
  constructor() {
    super();
    this.identity = getOrCreateIdentity();
    /** @type {Map<string, CameraSession>} */
    this.pairedCameras = new Map();
    this.seqCounter = 1;
  }

  nextSeq() { const s = this.seqCounter & 0xFFFF; this.seqCounter = (this.seqCounter + 1) & 0xFFFF; return s; }

  isSupported() { return 'bluetooth' in navigator; }

  log(kind, msg) { this.dispatchEvent(new CustomEvent('log', { detail: { kind, msg } })); }

  _emitStatus(session) {
    this.dispatchEvent(new CustomEvent('statusChange', { detail: { session } }));
  }

  async scanAndPair() {
    if (!this.isSupported()) throw new Error('Web Bluetooth not available. Use Chrome on Android over HTTPS or http://localhost.');

    const device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [DJI_SERVICE] }],
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
    const sessions = Array.from(this.pairedCameras.values()).filter(s => s.connected);
    if (sessions.length === 0) throw new Error('No connected cameras');
    const results = await Promise.all(sessions.map(s =>
      s.startRecord().then(() => ({ ok: true, session: s })).catch(err => ({ ok: false, session: s, err }))
    ));
    for (const r of results) {
      if (r.ok) { r.session.recording = true; this._emitStatus(r.session); }
    }
    return results;
  }

  async stopRecordAll() {
    const sessions = Array.from(this.pairedCameras.values()).filter(s => s.connected);
    if (sessions.length === 0) throw new Error('No connected cameras');
    const results = await Promise.all(sessions.map(s =>
      s.stopRecord().then(() => ({ ok: true, session: s })).catch(err => ({ ok: false, session: s, err }))
    ));
    for (const r of results) {
      if (r.ok) { r.session.recording = false; this._emitStatus(r.session); }
    }
    return results;
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
    this.pendingResponses = new Map(); // key: `${cmdSet}:${cmdId}` -> { resolve, reject, timer }
    this.pendingCmdRequests = []; // camera-initiated requests waiting to be consumed by handshake
    this.stored = loadCameraRecord(device.id);
    this.onGattDisconnected = this.onGattDisconnected.bind(this);
  }

  onGattDisconnected() {
    this.connected = false;
    this.control.log('warn', `${this.device.name || this.device.id} disconnected`);
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
  }

  disconnect() {
    try {
      if (this.server && this.server.connected) this.server.disconnect();
    } catch {}
    this.connected = false;
  }

  // Accumulate notification bytes and try to extract complete frames.
  onNotification(dv) {
    const incoming = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
    // Append to buffer
    const merged = new Uint8Array(this.rxBuffer.length + incoming.length);
    merged.set(this.rxBuffer, 0);
    merged.set(incoming, this.rxBuffer.length);
    this.rxBuffer = merged;

    // Extract frames
    while (this.rxBuffer.length >= 3) {
      // Resync to SOF
      if (this.rxBuffer[0] !== 0xAA) {
        const sof = this.rxBuffer.indexOf(0xAA);
        if (sof < 0) { this.rxBuffer = new Uint8Array(0); return; }
        this.rxBuffer = this.rxBuffer.slice(sof);
        if (this.rxBuffer.length < 3) return;
      }
      const total = (this.rxBuffer[1] | (this.rxBuffer[2] << 8)) & 0x3FF;
      if (total < 18) {
        // Bogus, skip one byte and retry
        this.rxBuffer = this.rxBuffer.slice(1);
        continue;
      }
      if (this.rxBuffer.length < total) return; // wait for more
      const frame = this.rxBuffer.slice(0, total);
      this.rxBuffer = this.rxBuffer.slice(total);
      const parsed = parseFrame(frame);
      if (!parsed.ok) {
        this.control.log('warn', `frame parse error: ${parsed.reason} raw=${hex(frame)}`);
        continue;
      }
      this.dispatchFrame(parsed);
    }
  }

  dispatchFrame(f) {
    const key = `${f.cmdSet.toString(16)}:${f.cmdId.toString(16)}`;
    this.control.log('ok', `⇐ ${key} type=0x${f.cmdType.toString(16)} seq=${f.seq} data=${hex(f.data)}`);

    // If this is a response (ACK bit set) and someone is awaiting it, resolve.
    if ((f.cmdType & 0x20) !== 0) {
      const waiter = this.pendingResponses.get(key);
      if (waiter) {
        clearTimeout(waiter.timer);
        this.pendingResponses.delete(key);
        waiter.resolve(f);
        return;
      }
    }
    // Camera-initiated commands (not acks) — stash so handshake can consume.
    if ((f.cmdType & 0x20) === 0) {
      this.pendingCmdRequests.push(f);
      // Also resolve any handshake waiter expecting a specific cmd.
      const cmdWaiter = this.pendingResponses.get(`cmd:${key}`);
      if (cmdWaiter) {
        clearTimeout(cmdWaiter.timer);
        this.pendingResponses.delete(`cmd:${key}`);
        cmdWaiter.resolve(f);
      }
      return;
    }

    // Special: camera status push on 1D/02 — parse battery if possible (not critical)
    if (f.cmdSet === 0x1D && f.cmdId === 0x02 && f.data.length >= 20) {
      // Camera status push — we don't parse full struct, but battery is somewhere in there.
    }
  }

  async sendCommand({ cmdSet, cmdId, cmdType, data, awaitResponse = false, awaitCommand = false, timeoutMs = 3000 }) {
    const seq = this.control.nextSeq();
    const frame = buildFrame(cmdSet, cmdId, cmdType, data, seq);
    this.control.log('ok', `⇒ ${cmdSet.toString(16)}:${cmdId.toString(16)} type=0x${cmdType.toString(16)} seq=${seq} data=${hex(data)}`);

    let responsePromise = null;
    if (awaitResponse) {
      responsePromise = new Promise((resolve, reject) => {
        const key = `${cmdSet.toString(16)}:${cmdId.toString(16)}`;
        const timer = setTimeout(() => {
          this.pendingResponses.delete(key);
          reject(new Error(`Timeout awaiting response for ${key}`));
        }, timeoutMs);
        this.pendingResponses.set(key, { resolve, reject, timer });
      });
    } else if (awaitCommand) {
      responsePromise = new Promise((resolve, reject) => {
        const key = `cmd:${cmdSet.toString(16)}:${cmdId.toString(16)}`;
        const timer = setTimeout(() => {
          this.pendingResponses.delete(key);
          reject(new Error(`Timeout awaiting camera command for ${key}`));
        }, timeoutMs);
        this.pendingResponses.set(key, { resolve, reject, timer });
      });
    }

    // Write the frame. For now, try writeValueWithoutResponse if supported
    // (matches rhoenschrat's behavior); fall back to writeValueWithResponse.
    const write = this.writeChar.writeValueWithoutResponse || this.writeChar.writeValue;
    await write.call(this.writeChar, frame);

    if (responsePromise) return responsePromise;
    return seq;
  }

  // Register a waiter for a camera-initiated command frame (cmdType bit 5 clear).
  waitForCameraCommand(cmdSet, cmdId, timeoutMs) {
    const key = `cmd:${cmdSet.toString(16)}:${cmdId.toString(16)}`;
    // If one already arrived before we registered, consume it immediately.
    const already = this.pendingCmdRequests.find(f => f.cmdSet === cmdSet && f.cmdId === cmdId);
    if (already) {
      this.pendingCmdRequests = this.pendingCmdRequests.filter(f => f !== already);
      return Promise.resolve(already);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingResponses.delete(key);
        reject(new Error(`Timeout waiting for camera-initiated ${cmdSet.toString(16)}:${cmdId.toString(16)}`));
      }, timeoutMs);
      this.pendingResponses.set(key, { resolve, reject, timer });
    });
  }

  async handshake() {
    const identity = this.control.identity;
    const reconnect = !!this.stored;
    const verifyMode = reconnect ? 0 : 1;
    const verifyData = 0;

    this.control.log('ok', `Handshake: ${reconnect ? 'RECONNECT' : 'NEW PAIR'} (mode=${verifyMode}) deviceId=0x${identity.deviceId.toString(16)}`);

    const payload = buildConnectionRequest({
      deviceId: identity.deviceId,
      macAddr: identity.macAddr,
      fwVersion: identity.fwVersion,
      verifyMode,
      verifyData,
    });

    // Register STEP 3 waiter FIRST so we don't race the camera.
    const cameraReqPromise = this.waitForCameraCommand(0x00, 0x19, reconnect ? 5000 : 60000);

    // STEP 1+2: Send connection request, expect ACK response.
    const resp = await this.sendCommand({
      cmdSet: 0x00, cmdId: 0x19,
      cmdType: CMD_WAIT_RESULT,
      data: payload,
      awaitResponse: true,
      timeoutMs: reconnect ? 3000 : 20000,
    });
    if (resp.data.length < 5) throw new Error(`Short handshake response: ${hex(resp.data)}`);
    const retCode = resp.data[4];
    if (retCode !== 0) throw new Error(`Handshake ret_code=${retCode}`);

    if (!reconnect) this.control.log('warn', 'Confirm pairing on the camera screen now…');

    // STEP 3: Await camera-initiated 0x00/0x19.
    const cameraReq = await cameraReqPromise;

    if (cameraReq.data.length < 29) throw new Error(`Short camera request: ${hex(cameraReq.data)}`);
    const camDv = new DataView(cameraReq.data.buffer, cameraReq.data.byteOffset, cameraReq.data.byteLength);
    const cameraDeviceId = camDv.getUint32(0, true);
    const camVerifyMode = cameraReq.data[26];
    const camVerifyData = camDv.getUint16(27, true);
    if (camVerifyMode !== 2) throw new Error(`Unexpected camera verify_mode=${camVerifyMode}`);
    if (camVerifyData !== 0) throw new Error(`Camera rejected pair: verify_data=${camVerifyData}`);

    // STEP 4: Send response ACK using the camera's SEQ
    const ackPayload = buildConnectionResponse({
      deviceId: identity.deviceId,
      retCode: 0,
      cameraReserved: 0,
    });
    // Build frame directly so we can use the received seq.
    const ackFrame = buildFrame(0x00, 0x19, ACK_NO_RESPONSE, ackPayload, cameraReq.seq);
    const write = this.writeChar.writeValueWithoutResponse || this.writeChar.writeValue;
    await write.call(this.writeChar, ackFrame);
    this.control.log('ok', `⇒ 0:19 ACK seq=${cameraReq.seq}`);

    // Persist reconnect info
    saveCameraRecord(this.device.id, {
      cameraDeviceId,
      pairedAt: Date.now(),
    });
    this.stored = loadCameraRecord(this.device.id);
  }

  async startRecord() {
    const identity = this.control.identity;
    const payload = buildRecordControl({ deviceId: identity.deviceId, start: true });
    await this.sendCommand({
      cmdSet: 0x1D, cmdId: 0x03,
      cmdType: CMD_NO_RESPONSE,
      data: payload,
    });
  }

  async stopRecord() {
    const identity = this.control.identity;
    const payload = buildRecordControl({ deviceId: identity.deviceId, start: false });
    await this.sendCommand({
      cmdSet: 0x1D, cmdId: 0x03,
      cmdType: CMD_NO_RESPONSE,
      data: payload,
    });
  }
}

function hex(bytes) {
  if (!bytes || !bytes.length) return '';
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(' ');
}
