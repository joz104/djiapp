// BLE transport abstraction.
//
// CameraSession used to call navigator.bluetooth directly. That doesn't work
// inside Capacitor's Android WebView (Android still doesn't ship Web Bluetooth
// in 2026). This file provides a uniform interface with two implementations:
//
//   webBluetoothTransport     — uses navigator.bluetooth (browser / PWA dev)
//   capacitorBleTransport     — uses window.Capacitor.Plugins.BluetoothLe
//                               (inside the Android APK)
//
// selectTransport() returns the right one at module load time based on
// whether Capacitor has injected window.Capacitor.Plugins.
//
// Interface (all methods async):
//   initialize(): Promise<void>
//   requestDevice({ optionalServices }): Promise<Handle>
//   connect(handle, { onDisconnect }): Promise<void>
//   disconnect(handle): Promise<void>
//   startNotifications(handle, service, char, onValue): Promise<void>
//     — onValue receives a DataView
//   writeWithoutResponse(handle, service, char, bytes): Promise<void>
//     — bytes is a Uint8Array
//
// Handle is an opaque object; the transport owns its internal shape.
//   webBluetoothTransport:  { kind:'web', device, server, chars:Map<key,char>, name, id }
//   capacitorBleTransport:  { kind:'cap', deviceId, name }

// ---- Base64 <-> Uint8Array (needed for Capacitor's native bridge) ------
function uint8ToBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
function base64ToUint8(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---- Web Bluetooth transport (for browser dev / PWA mode) --------------
export const webBluetoothTransport = {
  name: 'web-bluetooth',

  async initialize() {
    if (typeof navigator === 'undefined' || !('bluetooth' in navigator)) {
      throw new Error('Web Bluetooth not available in this browser');
    }
  },

  async requestDevice({ optionalServices }) {
    const device = await navigator.bluetooth.requestDevice({
      acceptAllDevices: true,
      optionalServices,
    });
    return {
      kind: 'web',
      device,
      server: null,
      chars: new Map(),
      name: device.name,
      id: device.id,
    };
  },

  async connect(handle, { onDisconnect }) {
    // Reset per-connection state — characteristics from a prior session
    // become invalid after gatt disconnect and must be re-fetched.
    handle.chars = new Map();
    handle.server = null;
    if (!handle._disconnectBound) {
      handle.device.addEventListener('gattserverdisconnected', onDisconnect);
      handle._disconnectBound = true;
    }
    handle.server = await handle.device.gatt.connect();
  },

  async disconnect(handle) {
    try {
      if (handle.server && handle.server.connected) handle.server.disconnect();
    } catch {}
  },

  async _getChar(handle, serviceUuid, charUuid) {
    const key = `${serviceUuid}|${charUuid}`;
    let char = handle.chars.get(key);
    if (char) return char;
    const service = await handle.server.getPrimaryService(serviceUuid);
    char = await service.getCharacteristic(charUuid);
    handle.chars.set(key, char);
    return char;
  },

  async startNotifications(handle, serviceUuid, charUuid, onValue) {
    const char = await this._getChar(handle, serviceUuid, charUuid);
    char.addEventListener('characteristicvaluechanged', (ev) => {
      onValue(ev.target.value); // DataView
    });
    try { await char.startNotifications(); } catch (e) {
      // Some characteristics don't advertise NOTIFY even if they deliver events.
      // Log-and-continue matches our pre-refactor behavior for FFF5.
      console.warn(`startNotifications failed for ${charUuid}:`, e.message);
    }
  },

  async writeWithoutResponse(handle, serviceUuid, charUuid, bytes) {
    const char = await this._getChar(handle, serviceUuid, charUuid);
    if (char.writeValueWithoutResponse) {
      await char.writeValueWithoutResponse(bytes);
    } else {
      await char.writeValue(bytes);
    }
  },
};

// ---- Capacitor BLE transport (for Android APK) -------------------------
// Talks to window.Capacitor.Plugins.BluetoothLe directly without importing
// the npm wrapper, so we don't need a bundler. The native bridge API is
// the same shape as the wrapper — it just takes/returns plain objects and
// expects bytes as base64 strings.

function capPlugin() {
  if (typeof window === 'undefined') return null;
  if (!window.Capacitor || !window.Capacitor.Plugins) return null;
  return window.Capacitor.Plugins.BluetoothLe || null;
}

export const capacitorBleTransport = {
  name: 'capacitor-ble',

  async initialize() {
    const ble = capPlugin();
    if (!ble) throw new Error('Capacitor BluetoothLe plugin not available (are you inside the APK?)');
    await ble.initialize({ androidNeverForLocation: true });
  },

  async requestDevice({ optionalServices }) {
    const ble = capPlugin();
    // services:[] asks for a global scan (Web Bluetooth's acceptAllDevices
    // equivalent). optionalServices is the list we may access later.
    const dev = await ble.requestDevice({
      services: [],
      optionalServices,
    });
    return {
      kind: 'cap',
      deviceId: dev.deviceId,
      name: dev.name,
      id: dev.deviceId,
      _listeners: [],
    };
  },

  async connect(handle, { onDisconnect }) {
    const ble = capPlugin();
    // Remove any listeners from a prior session — native bridge listeners
    // persist across JS reconnects and would fire duplicate callbacks.
    for (const l of handle._listeners || []) {
      try { if (l && l.remove) await l.remove(); } catch {}
    }
    handle._listeners = [];
    const disListener = await ble.addListener(`disconnect|${handle.deviceId}`, () => {
      try { onDisconnect(); } catch {}
    });
    handle._listeners.push(disListener);
    await ble.connect({ deviceId: handle.deviceId, timeout: 20000 });
  },

  async disconnect(handle) {
    const ble = capPlugin();
    try { await ble.disconnect({ deviceId: handle.deviceId }); } catch {}
    for (const l of handle._listeners || []) {
      try { if (l && l.remove) await l.remove(); } catch {}
    }
    handle._listeners = [];
  },

  async startNotifications(handle, serviceUuid, charUuid, onValue) {
    const ble = capPlugin();
    const eventKey = `notification|${handle.deviceId}|${serviceUuid}|${charUuid}`;
    const listener = await ble.addListener(eventKey, (event) => {
      // event.value is base64 in the native bridge; decode to DataView
      // so the receiver code matches the Web Bluetooth contract.
      const bytes = base64ToUint8(event.value || '');
      const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      onValue(dv);
    });
    handle._listeners.push(listener);
    await ble.startNotifications({
      deviceId: handle.deviceId,
      service: serviceUuid,
      characteristic: charUuid,
    });
  },

  async writeWithoutResponse(handle, serviceUuid, charUuid, bytes) {
    const ble = capPlugin();
    await ble.writeWithoutResponse({
      deviceId: handle.deviceId,
      service: serviceUuid,
      characteristic: charUuid,
      value: uint8ToBase64(bytes),
    });
  },
};

// ---- Transport factory --------------------------------------------------
export function selectTransport() {
  if (typeof window !== 'undefined' && window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()) {
    return capacitorBleTransport;
  }
  return webBluetoothTransport;
}
