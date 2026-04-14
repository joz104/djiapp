// DJIControl — Web Bluetooth control for DJI Osmo Action cameras.
//
// IMPORTANT: DJI does not publish their BLE protocol. The service/characteristic
// UUIDs and record opcodes below are community-sourced / placeholders. You will
// almost certainly need to sniff packets from the official DJI Mimo app once
// to discover the real bytes for your camera firmware.
//
// HOW TO SNIFF THE RECORD OPCODES (Android):
//   1. Enable Developer Options on your phone, turn on "Enable Bluetooth HCI snoop log".
//   2. Toggle Bluetooth off and on to start a fresh log.
//   3. Open DJI Mimo, pair with the Osmo Action, tap the shutter to start recording,
//      wait 3s, tap again to stop. Close Mimo.
//   4. `adb bugreport bug.zip`  (or pull /sdcard/btsnoop_hci.log directly)
//   5. Open btsnoop_hci.log in Wireshark. Filter: `btatt.opcode == 0x52` (Write Command)
//      or `btatt.opcode == 0x12` (Write Request). Look at writes to a custom 0xFFxx handle.
//   6. The payload for the record-start and record-stop taps are what you want.
//      Copy the bytes into RECORD_START_BYTES / RECORD_STOP_BYTES below.
//   7. Also note the service UUID and characteristic UUID from Wireshark
//      ("Primary Service" and "Characteristic Declaration" rows) and update the
//      constants below if they differ from the defaults.

// Common community-reported DJI BLE service UUIDs. We try each in order.
const CANDIDATE_SERVICES = [
  '0000fff0-0000-1000-8000-00805f9b34fb',
  '0000ff10-0000-1000-8000-00805f9b34fb',
];

// Community-reported control characteristic UUIDs. Tried in order.
const CANDIDATE_CONTROL_CHARS = [
  '0000fff1-0000-1000-8000-00805f9b34fb',
  '0000fff2-0000-1000-8000-00805f9b34fb',
  '0000ff11-0000-1000-8000-00805f9b34fb',
];

// PLACEHOLDER: replace with real bytes after sniffing (see header comment).
// Shipping as a single 0x00 byte so writes fail loudly and visibly rather than
// triggering an unknown camera command.
export const RECORD_START_BYTES = new Uint8Array([0x00]);
export const RECORD_STOP_BYTES  = new Uint8Array([0x00]);

export class DJIControl extends EventTarget {
  constructor() {
    super();
    /** @type {Map<string, {device: BluetoothDevice, server: BluetoothRemoteGATTServer, controlChar: BluetoothRemoteGATTCharacteristic, batteryChar: BluetoothRemoteGATTCharacteristic|null, battery: number|null, recording: boolean}>} */
    this.pairedCameras = new Map();
  }

  isSupported() {
    return 'bluetooth' in navigator;
  }

  _emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  async scanAndPair() {
    if (!this.isSupported()) throw new Error('Web Bluetooth not available — use Chrome on Android over HTTPS or localhost.');

    const device = await navigator.bluetooth.requestDevice({
      filters: [
        { namePrefix: 'DJI' },
        { namePrefix: 'Osmo' },
        { namePrefix: 'OsmoAction' },
      ],
      optionalServices: [
        ...CANDIDATE_SERVICES,
        'battery_service',
        'device_information',
      ],
    });

    device.addEventListener('gattserverdisconnected', () => {
      const entry = this.pairedCameras.get(device.id);
      if (entry) entry.recording = false;
      this._emit('statusChange', { device, connected: false });
    });

    const server = await device.gatt.connect();

    // Try each candidate service until one resolves.
    let service = null;
    let lastErr = null;
    for (const uuid of CANDIDATE_SERVICES) {
      try {
        service = await server.getPrimaryService(uuid);
        if (service) break;
      } catch (e) { lastErr = e; }
    }
    if (!service) {
      server.disconnect();
      throw new Error('No known DJI service found on device. Sniff the real UUID and add to CANDIDATE_SERVICES. Last error: ' + (lastErr?.message || 'unknown'));
    }

    let controlChar = null;
    for (const uuid of CANDIDATE_CONTROL_CHARS) {
      try {
        controlChar = await service.getCharacteristic(uuid);
        if (controlChar) break;
      } catch (e) { /* try next */ }
    }
    if (!controlChar) {
      server.disconnect();
      throw new Error('No known DJI control characteristic found. Sniff and add to CANDIDATE_CONTROL_CHARS.');
    }

    let batteryChar = null;
    try {
      const battSvc = await server.getPrimaryService('battery_service');
      batteryChar = await battSvc.getCharacteristic('battery_level');
    } catch { /* battery service not exposed — that's fine */ }

    const entry = {
      device,
      server,
      controlChar,
      batteryChar,
      battery: null,
      recording: false,
    };
    this.pairedCameras.set(device.id, entry);

    if (batteryChar) {
      try {
        const val = await batteryChar.readValue();
        entry.battery = val.getUint8(0);
        await batteryChar.startNotifications();
        batteryChar.addEventListener('characteristicvaluechanged', (ev) => {
          entry.battery = ev.target.value.getUint8(0);
          this._emit('statusChange', { device, battery: entry.battery, connected: true });
        });
      } catch { /* ignore */ }
    }

    this._emit('statusChange', { device, connected: true, battery: entry.battery });
    return entry;
  }

  async disconnect(deviceId) {
    const entry = this.pairedCameras.get(deviceId);
    if (!entry) return;
    try { entry.server.disconnect(); } catch {}
    this.pairedCameras.delete(deviceId);
    this._emit('statusChange', { device: entry.device, connected: false });
  }

  async _writeAll(bytes) {
    const writes = [];
    for (const entry of this.pairedCameras.values()) {
      writes.push(
        entry.controlChar.writeValueWithResponse(bytes)
          .then(() => ({ ok: true, entry }))
          .catch((err) => ({ ok: false, entry, err }))
      );
    }
    return Promise.all(writes);
  }

  async startRecordAll() {
    const results = await this._writeAll(RECORD_START_BYTES);
    for (const r of results) {
      if (r.ok) {
        r.entry.recording = true;
        this._emit('statusChange', { device: r.entry.device, recording: true, connected: true, battery: r.entry.battery });
      } else {
        this._emit('writeError', { device: r.entry.device, error: r.err });
      }
    }
    return results;
  }

  async stopRecordAll() {
    const results = await this._writeAll(RECORD_STOP_BYTES);
    for (const r of results) {
      if (r.ok) {
        r.entry.recording = false;
        this._emit('statusChange', { device: r.entry.device, recording: false, connected: true, battery: r.entry.battery });
      } else {
        this._emit('writeError', { device: r.entry.device, error: r.err });
      }
    }
    return results;
  }
}
