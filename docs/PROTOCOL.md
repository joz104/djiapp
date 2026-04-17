# DJI Osmo Action BLE Protocol

Deep-dive on the BLE control protocol used by DJI Osmo Action cameras, as understood empirically against an Osmo Action 3. Update this file as we learn more.

## Context: there are TWO protocols

DJI Osmo Action cameras expose one BLE service (`0xFFF0`) on characteristics `0xFFF3` (write) and `0xFFF4` / `0xFFF5` (notify). But there are **two incompatible protocols** spoken over those characteristics:

| Protocol | SOF | Used by | Supports |
|---|---|---|---|
| **node-osmo / Moblin** | `0x55` | DJI Mimo "Livestream via RTMP" | Pair, Wi-Fi setup, RTMP livestream start/stop. **No SD record.** |
| **DJI R-SDK / GPS Remote** | `0xAA` | DJI Osmo GPS Remote (GL2) | Pair, SD record start/stop, mode switch, highlight tag, key events. |

**The Osmo Action 3 speaks the `0x55` protocol only.** Confirmed empirically.

**The Osmo Action 4 speaks BOTH protocols.** Confirmed 2026-04-16:
- `0x55` for pair handshake (same pair frame as Action 3)
- `0xAA` for record, mode switch, status push, and all camera commands
- The Action 4 ignores 0x55 record commands (CmdSet=0x02/CmdID=0x02) entirely — no response, no error
- `0xAA` writes go to **FFF5** (not FFF3 like 0x55)
- Notifications for both protocols arrive on **FFF4** (detected by SOF byte)

This document covers both protocols. The `0x55` section is first, then `0xAA`.

---

## `0x55` protocol frame layout

All multibyte fields are **little-endian**.

```
off  size  field
 0    1    SOF = 0x55
 1    1    totalLen (including SOF and both CRCs)
 2    1    version = 0x04
 3    1    CRC8 over bytes[0..2]
 4    2    target (u16)
 6    2    txId / transactionId (u16)
 8    3    type (u24)
11    N    payload
11+N  2    CRC16 over bytes[0..totalLen-3] (LE)
```

- `totalLen` = `13 + len(payload)`. Maximum frame is 255 bytes.
- `target` identifies the logical target (camera component / subsystem). Known values: `0x0702` (pair), `0x0802` (stream control), `0x0102` (configure), `0x0205` (status push direction).
- `txId` is an identifier to match responses to requests. Most request-response pairs use a fixed constant; status push messages use a monotonic counter.
- `type` is a 3-byte opcode. Known values below.

### CRC8 — header check

- Polynomial: `0x31`, reflected → `0x8C`
- Init: `0xEE` (logical) — **must be bit-reversed to `0x77` when using a hand-rolled reflected-table implementation**
- Reflected in/out: true
- Xorout: `0x00`
- Covers bytes `[0..2]`: `[SOF, totalLen, version]`
- Result stored at byte `[3]`

```js
const CRC8_TABLE = (() => {
  const t = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? ((c >>> 1) ^ 0x8C) : (c >>> 1);
    t[i] = c;
  }
  return t;
})();
function djiCrc8(bytes) {
  let crc = 0x77; // pre-reflected init
  for (const b of bytes) crc = CRC8_TABLE[(crc ^ b) & 0xFF];
  return crc;
}
```

### CRC16 — body check

- Polynomial: `0x1021`, reflected → `0x8408`
- Init: `0x496C` (logical) — **must be bit-reversed to `0x3692` when using a hand-rolled reflected-table implementation**
- Reflected in/out: true
- Xorout: `0x0000`
- Covers bytes `[0..totalLen-3]` (everything except the CRC16 bytes)
- Result stored at bytes `[totalLen-2, totalLen-1]` (LE)

```js
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
  let crc = 0x3692; // pre-reflected init
  for (const b of bytes) crc = (CRC16_TABLE[(crc ^ b) & 0xFF] ^ (crc >>> 8)) & 0xFFFF;
  return crc;
}
```

### CRC gotcha explained

node-osmo's TypeScript code passes `init=0xEE` and `init=0x496C` to the `crc-full` library. When `refIn=true`, crc-full bit-reverses the init value internally before applying it. A hand-rolled reflected-table implementation does not do that — it applies the init directly. So to match crc-full's output, you must pre-reflect the init yourself.

Validated empirically against a real Osmo Action 3 frame:

```
Raw: 55 2f 04 63 05 02 29 01 00 0d 02 [34 payload bytes] 44 2b
Header [55 2f 04]  → CRC8 = 0x63  ✓
Body   [55 … 01]   → CRC16 = 0x2b44  ✓ (LE: 44 2b)
```

---

## Message catalog

All constants verbatim from `datagutt/node-osmo/src/device.ts` unless noted.

### Pair handshake

| Field | Value |
|---|---|
| target | `0x0702` |
| txId | `0x8092` |
| type | `0x450740` |
| payload | 33 static bytes + `djiPackString("love")` (5 bytes) = 38 bytes total |

The 33 static bytes spell ASCII `" 284ae5b8d76b3375a04a6417ad71bea3"` (leading space `0x20`). `djiPackString("love")` produces `[0x04, 0x6c, 0x6f, 0x76, 0x65]` — length byte `0x04` then UTF-8 `"love"`.

Hex dump of the full pair payload:

```
20 32 38 34 61 65 35 62 38 64 37 36 62 33 33 37
35 61 30 34 61 36 34 31 37 61 64 37 31 62 65 61
33 04 6c 6f 76 65
```

**Empirical finding (2026-04-14)**: on the Osmo Action 3, sending this pair message causes the camera to display a **"confirm pairing code" prompt on its screen**. This is not documented in node-osmo — node-osmo seems to assume auto-accept or prior pairing. The post-confirmation flow is still being reverse-engineered; whatever frames arrive on FFF4 after the user taps accept need to be logged and decoded.

### RTMP livestream setup (not for SD record, but useful reference)

| Name | target | txId | type | payload |
|---|---|---|---|---|
| stopStreaming | `0x0802` | `0xEAC8` | `0x8E0240` | `01 01 1A 00 01 02` |
| preparingToLivestream | `0x0802` | `0x8C12` | `0xE10240` | `1A` |
| setupWifi | `0x0702` | `0x8C19` | `0x470740` | `djiPackString(ssid)` + `djiPackString(password)` |
| configure (EIS) | `0x0102` | `0x8C2D` | `0x8E0240` | 1-byte image stabilization mode |
| startStreaming | `0x0802` | `0x8C2C` | `0x780840` | resolution, fps, bitrate, RTMP URL (see node-osmo/src/message.ts `DjiStartStreamingMessagePayload`) |
| confirmStartStreaming | `0x0802` | `0xEAC8` | `0x8E0240` | `01 01 1A 00 01 01` (Action 5 Pro only) |

### Camera → remote status push

Captured empirically from the Osmo Action 3 while connected but before handshake completed. Example frame:

```
55 2f 04 63 05 02 29 01 00 0d 02 [18 bytes of 0x00] 4a 01 00 1f 00 00 00 00 00 00 20 04 00 00 00
                                                                                          + CRC16 [44 2b]
```

- target = `0x0205`
- txId = `0x0129` (monotonic — subsequent frames show `0x012a`, `0x012b`, ...)
- type = `0x020d00`

Frequency: ~1 frame every ~200ms.

**TODO**: decode the payload. The `0x4a` byte may be a camera mode / state indicator; `0x1f` / `0x20 04` may be battery or storage. Manually toggle recording on the camera (physical shutter button), observe which bytes change, and annotate here. This is the most accessible way to find the "is recording" bit without sniffing Mimo.

### SD record start/stop

**Unknown.** node-osmo does not implement it. Three approaches to find it:

1. **Sniff DJI Mimo.** Enable Bluetooth HCI snoop log on an Android phone, open Mimo, pair with the Action 3, tap the SD-record shutter, tap again, close Mimo, pull `/sdcard/btsnoop_hci.log`, open in Wireshark, filter `btatt.opcode == 0x52` writing to handle for FFF3. The payloads sent during the shutter taps are the record-start / record-stop messages.
2. **Grep `eerimoq/moblin`** — Swift upstream of node-osmo, may have code node-osmo dropped.
3. **Brute-force guessing.** There are only so many `target/type` combinations. If we can identify a consistent pattern (e.g. target `0x0x02`, type `0xNN0NN0`), we can send candidates and watch the status push for state changes.

---

## BLE connection details

### Characteristics

| UUID | Purpose | Properties |
|---|---|---|
| `0000fff0-0000-1000-8000-00805f9b34fb` | Service | — |
| `0000fff3-0000-1000-8000-00805f9b34fb` | Write commands to camera | WRITE, WRITE_NO_RESPONSE, READ, NOTIFY |
| `0000fff4-0000-1000-8000-00805f9b34fb` | Notifications from camera (primary) | NOTIFY, INDICATE, READ, WRITE |
| `0000fff5-0000-1000-8000-00805f9b34fb` | Notifications (secondary) | NOTIFY, INDICATE, READ, WRITE, WRITE_NO_RESPONSE |

Subscribe to notifications on both FFF4 and FFF5. Some frame types arrive on one, some on the other.

Writes should use `writeValueWithoutResponse` when available (matches node-osmo's `writeAsync(false)` behavior), falling back to `writeValue` if the characteristic doesn't permit it.

### Scanning and pairing

- **The Action 3 does not advertise the `0xFFF0` service UUID in its scan response** — only its BLE device name. A service-UUID filter in `navigator.bluetooth.requestDevice` returns zero results.
- **Fix**: `acceptAllDevices: true` with `optionalServices: [DJI_SERVICE]`. User picks the camera by name. The camera's advertised name is the phone's Bluetooth name that Mimo used during its last pairing — e.g. `johnzorychta`, not `DJI-OsmoAction3`.
- **The Action 3 refuses OS-level BLE bonding.** It explicitly tells the user "use DJI Mimo" if you try to pair through Android Bluetooth settings. But `navigator.bluetooth.requestDevice` → `gatt.connect()` does a plain GATT connection without bonding, which the camera accepts. "Connected, not bonded" in nRF Connect is the target state.

### MTU

Chrome Web Bluetooth on Android negotiates MTU automatically; typical values are 185–517 bytes. The pair frame is 51 bytes and record frames will be small — both fit comfortably in any modern MTU. If the camera sends fragmented notifications for longer frames, the accumulator in `CameraSession.onNotification` reassembles them by SOF + `totalLen`.

---

## Gotcha log — things we learned the hard way

| Date | Gotcha |
|---|---|
| 2026-04-14 | Picked wrong protocol (0xAA instead of 0x55). Camera never responded. Fix: looked at raw notification bytes, saw SOF=0x55, pivoted. |
| 2026-04-14 | Hand-rolled CRC didn't match crc-full's output. Fix: bit-reverse the init values (0xEE → 0x77, 0x496C → 0x3692). |
| 2026-04-14 | Service-UUID scan filter returned zero devices. Fix: `acceptAllDevices: true`. |
| 2026-04-14 | Action 3 pair triggers a **"confirm pairing code" prompt on the camera screen**. Not documented in node-osmo. TBD how to handle the post-confirmation flow. |

---

---

## `0xAA` R-SDK protocol (Action 4+)

Confirmed working on Osmo Action 4 as of 2026-04-16. Reference implementations: rhoenschrat/DJI-Remote (ESP32, C) and dji-sdk/Osmo-GPS-Controller-Demo (STM32, C).

### Frame layout

All multibyte fields **little-endian**.

```
off  size  field
 0    1    SOF = 0xAA
 1    2    ver(6b, bits[15:10]) | length(10b, bits[9:0])  — version=0
 3    1    CmdType  (bit5=isResponse, bits[4:0]=ack mode: 0=none, 1=optional, 2=required)
 4    1    ENC = 0x00 (no encryption)
 5    3    reserved (zeros)
 8    2    SEQ (u16) — sequence number, matches responses to requests
10    2    CRC16 over bytes[0..9]
12    1    CmdSet
13    1    CmdID
14    N    data payload
14+N  4    CRC32 over bytes[0..13+N]
```

- `totalLen` = `14 + len(payload) + 4` (header + data + CRC32)
- Version MUST be 0 (not 1)
- **Write to FFF5** (not FFF3 like 0x55)
- Responses arrive on FFF4 (same as 0x55), distinguished by SOF byte

### CRC16 — header check

- Polynomial: `0x8005`, reflected → `0xA001`
- **Init: `0x3AA3`** (NOT standard MODBUS 0xFFFF)
- Reflected in/out: true
- Xorout: `0x0000`
- Covers bytes `[0..9]`

### CRC32 — body check

- Polynomial: `0x04C11DB7`, reflected → `0xEDB88320`
- **Init: `0x3AA3`** (NOT standard 0xFFFFFFFF)
- Reflected in/out: true
- **Xorout: `0x0000`** (NOT standard 0xFFFFFFFF — no final XOR)
- Covers bytes `[0..totalLen-5]`

### Verified test vector

DJI SDK docs example (mode switch to Hyperlapse):
```
AA 1B 00 01 00 00 00 00 05 00 57 EE 1D 04 00 00 33 FF 0A 01 47 39 36 F4 FA E1 D0
```
- CRC16 over bytes[0..9] = 0xEE57 → bytes [57 EE] LE ✓
- CRC32 over bytes[0..22] = 0xD0E1FAF4 → bytes [F4 FA E1 D0] LE ✓

### Connection handshake (mandatory before any commands)

CmdSet=0x00, CmdID=0x19. Four steps:

1. **Controller → Camera** (CmdType=0x02, response required):
   ```
   Payload (33 bytes):
   [0..3]   device_id    = uint32 LE (any nonzero value, e.g. 0x12345678)
   [4]      mac_addr_len = 6
   [5..20]  mac_addr     = 16 bytes (pad with zeros)
   [21..24] fw_version   = uint32 LE = 0
   [25]     conidx       = 0
   [26]     verify_mode  = 1 (first pairing)
   [27..28] verify_data  = uint16 LE (random)
   [29..32] reserved     = zeros
   ```

2. **Camera → Controller** (response, same SEQ): `ret_code=0x00` at payload[4] = OK

3. **Camera → Controller** (new command frame, different SEQ): camera's own connection request with `verify_mode=2, verify_data=0` = accepted

4. **Controller → Camera** (CmdType=0x20 ACK, SAME SEQ as step 3):
   ```
   Payload (9 bytes):
   [0..3] device_id = same as step 1
   [4]    ret_code  = 0x00
   [5..8] reserved  = zeros
   ```

### Device IDs

| Model | device_id |
|---|---|
| Osmo Action 4 | `0xFF33` → wire bytes `[33, FF, 00, 00]` |
| Osmo Action 5 Pro | `0xFF44` |
| Osmo Action 6 | `0xFF55` |

### Command catalog

#### Record control (CmdSet=0x1D, CmdID=0x03)
```
Payload (9 bytes):
[0..3] device_id     = [33, FF, 00, 00] for Action 4
[4]    record_ctrl   = 0x00=start, 0x01=stop
[5..8] reserved      = zeros
```
Response: `[ret_code(1B), reserved(4B)]`. ret_code 0x00 = success.

#### Mode switch (CmdSet=0x1D, CmdID=0x04)
```
Payload (9 bytes):
[0..3] device_id  = [33, FF, 00, 00]
[4]    mode       = see table below
[5..8] reserved   = [0x01, 0x47, 0x39, 0x36] (magic, NOT zeros)
```

| Mode | Byte |
|---|---|
| Slow Motion | `0x00` |
| Video | `0x01` |
| Timelapse | `0x02` |
| Photo | `0x05` |
| Hyperlapse | `0x0A` |
| Livestream | `0x1A` |
| Night | `0x28` |

#### Status subscription (CmdSet=0x1D, CmdID=0x05)
```
Payload (6 bytes):
[0] push_mode = 0x03 (periodic + state change)
[1] push_freq = 0x14 (2 Hz, only valid value)
[2..5] reserved = zeros
```

#### Status push (CmdSet=0x1D, CmdID=0x02) — camera → controller, 38 bytes
```
[0]     camera_mode        (same byte values as mode switch)
[1]     camera_status      (0x00=off, 0x01=idle, 0x03=recording, 0x05=pre-rec)
[2]     video_resolution
[3]     fps_idx
[4]     eis_mode
[5..6]  record_time (u16, seconds)
[15..18] remain_capacity (u32, MB)
[19..22] remain_photo_num (u32)
[23..26] remain_time (u32, seconds)
[37]    battery (0-100%)
```

---

## Gotcha log — things we learned the hard way

| Date | Gotcha |
|---|---|
| 2026-04-14 | Picked wrong protocol (0xAA instead of 0x55). Camera never responded. Fix: looked at raw notification bytes, saw SOF=0x55, pivoted. |
| 2026-04-14 | Hand-rolled CRC didn't match crc-full's output. Fix: bit-reverse the init values (0xEE → 0x77, 0x496C → 0x3692). |
| 2026-04-14 | Service-UUID scan filter returned zero devices. Fix: `acceptAllDevices: true`. |
| 2026-04-14 | Action 3 pair triggers a **"confirm pairing code" prompt on the camera screen**. Not documented in node-osmo. TBD how to handle the post-confirmation flow. |
| 2026-04-16 | Action 4 pairs fine with 0x55 but ignores 0x55 record commands entirely (no response). Uses 0xAA R-SDK protocol for recording. |
| 2026-04-16 | First 0xAA attempt: wrote to FFF3 instead of FFF5 — camera never saw the frame. 0xAA writes go to FFF5. |
| 2026-04-16 | Second 0xAA attempt: used standard CRC16-MODBUS (init=0xFFFF) and CRC32 (init=0xFFFFFFFF). DJI uses custom init=0x3AA3 for both, and no final XOR on CRC32. |
| 2026-04-16 | Third 0xAA attempt: set version=1 in the ver/len field. DJI spec says version=0. |
| 2026-04-16 | 0xAA handshake is mandatory. Camera ignores all 0xAA commands without the 4-step CmdSet=0x00/CmdID=0x19 connection flow. |
| 2026-04-16 | Action 4 BLE name is "johnzorychta2" (phone name from Mimo), not "Action 4". Can't detect model from device name. |

---

## References

- [datagutt/node-osmo](https://github.com/datagutt/node-osmo) — primary reference for 0x55 protocol. `src/message.ts`, `src/device.ts`.
- [eerimoq/moblin](https://github.com/eerimoq/moblin) — Swift upstream. Double-check here if node-osmo seems incomplete.
- [rhoenschrat/DJI-Remote](https://github.com/rhoenschrat/DJI-Remote) — **primary reference for 0xAA protocol**. ESP32 C code, confirmed working on Action 4/5/6.
- [dji-sdk/Osmo-GPS-Controller-Demo](https://github.com/dji-sdk/Osmo-GPS-Controller-Demo) — DJI's official 0xAA protocol reference. `docs/protocol_data_segment.md` has the full command catalog.
- [crc-full (npm)](https://www.npmjs.com/package/crc-full) — the CRC library node-osmo uses. Be aware of its init-reflection behavior when porting.
