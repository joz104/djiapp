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

// ---- Hex string <-> Uint8Array (Capacitor BLE native bridge format) ----
// The @capacitor-community/bluetooth-le plugin's native Android code sends
// and receives byte values as lowercase hex strings (NOT base64) — verified
// against dist/esm/conversion.js's dataViewToHexString/hexStringToDataView
// helpers. Passing base64 to the plugin throws:
//   java.lang.IllegalArgumentException: Invalid Hexadecimal Character: <X>
// inside ConversionKt.toDigit at Device.write / writeWithoutResponse.
function uint8ToHex(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    const h = bytes[i].toString(16);
    out += h.length === 1 ? '0' + h : h;
  }
  return out;
}
function hexToUint8(hex) {
  if (!hex) return new Uint8Array(0);
  // Strip any whitespace the plugin may inject between bytes.
  const clean = hex.replace(/\s+/g, '');
  const out = new Uint8Array(clean.length >> 1);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.substr(i << 1, 2), 16);
  }
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

    // Plugin init. On Android 12+ this triggers the runtime BLUETOOTH_SCAN /
    // BLUETOOTH_CONNECT permission prompts. neverForLocation avoids the
    // location permission nag that older Androids forced on BLE scanning.
    // The plugin throws if the user denies.
    try {
      await ble.initialize({ androidNeverForLocation: true });
    } catch (e) {
      throw new Error(`Bluetooth initialize failed: ${e.message || e}. Check app permissions.`);
    }

    // Make sure the Bluetooth radio is actually on. requestEnable() pops the
    // system toggle dialog so the user can flip BT on without leaving the app.
    let enabled;
    try {
      const r = await ble.isEnabled();
      enabled = !!(r && r.value);
    } catch {
      enabled = true; // plugin may not expose isEnabled on all versions — assume ok
    }
    if (!enabled) {
      try {
        await ble.requestEnable();
      } catch {
        throw new Error('Bluetooth is off. Turn it on in Settings and try again.');
      }
      // Re-check after user interaction.
      try {
        const r2 = await ble.isEnabled();
        if (!(r2 && r2.value)) {
          throw new Error('Bluetooth is still off.');
        }
      } catch (e) {
        throw new Error(e.message || 'Bluetooth could not be enabled.');
      }
    }
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
      // event.value is a lowercase hex string in the native bridge; decode
      // to a DataView so the receiver code matches the Web Bluetooth
      // contract.
      const bytes = hexToUint8(event.value || '');
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
      value: uint8ToHex(bytes),
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
