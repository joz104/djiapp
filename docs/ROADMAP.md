# Roadmap

Phases, current state, and open blockers. The status log at the bottom is the running history of what changed per session — append new entries, don't rewrite old ones.

## Phases

### Phase 0 — project setup ✅
- [x] Vanilla JS + ES modules, no build step
- [x] PWA shell, manifest, service worker, dark theme
- [x] hls.js vendored locally for offline use
- [x] GitHub Pages deploy (https://joz104.github.io/djiapp/)
- [x] Project documentation (CLAUDE.md, README, PROTOCOL, ROADMAP)

### Phase 1 — BLE handshake ✅
- [x] Service/characteristic discovery (FFF0 / FFF3 / FFF4 / FFF5)
- [x] Scan without service filter (`acceptAllDevices` — Action 3 doesn't advertise FFF0)
- [x] 0x55 protocol frame builder and parser with correct CRCs
- [x] Notification reassembly (`CameraSession.onNotification`)
- [x] Pair message sent, camera responds with `0x00 0x01` immediately
- [ ] Test reconnect after disconnect (nice-to-have)

### Phase 2 — record control ✅
- [x] **Record opcode found.** `target=0x0102, type=0x020240 (CmdSet=0x02/CmdID=0x02 "Do Record"), payload=[0x01] start / [0x00] stop.` Opcode from DJI DUML dictionary (xaionaro-go/djictl + o-gs/dji-firmware-tools dissector); validated empirically against Action 3 on 2026-04-14 — camera replies on `target=0x0201, type=0x0202c0` with payload `0x00` on success.
- [x] Wire `startRecordAll` / `stopRecordAll` fan-out in `DJIControl` with `Promise.all` for parallel fire.
- [ ] Measure end-to-end latency between the two cameras when both are triggered (needs Action 4)
- [ ] Track recording state robustly — we currently flip `session.recording` on command success, but if the user presses the camera's physical shutter our state goes stale. Low priority until it matters.

### Phase 3 — second camera (Action 4) 🚧
- [ ] Receive Action 4 hardware
- [ ] Capture raw BLE notification bytes to determine which protocol it speaks (0x55 vs 0xAA)
- [ ] If it speaks 0xAA, fill in `dji0xaaDriver` with rhoenschrat's frame layout
- [x] Multi-protocol architecture — each `CameraSession` takes a driver; `selectDriver` chooses by device name with 0x55 as safe fallback
- [ ] Test synced record on both cameras from the master button

### Phase 4 — live preview pipeline ❌
- [ ] Decide: RTMP-to-local-server or skip live preview entirely
- [ ] If doing it: run SRS or nginx-rtmp on a laptop / tablet
- [ ] Use node-osmo's setupWifi + startStreaming to point cameras at the server
- [ ] Video panes pull HLS from the server via existing hls.js path
- [ ] Document the infra setup in docs/

### Phase 5 — polish ❌
- [ ] Connection state recovery (auto-reconnect on disconnect during a match)
- [ ] Battery / storage display from parsed camera status push
- [ ] Real PWA icons (currently solid-dark placeholders)
- [ ] Haptic feedback on master record tap
- [ ] Fail-safe indicator when only one camera responded
- [ ] Review accessibility (high contrast OK, but screen reader labels?)

## Open blockers (priority order)

1. **Action 4 untested.** Don't know yet whether it speaks 0x55, 0xAA, or both, and whether the same record opcode (`0x0102 / 0x020240`) works there. May require a second frame builder + protocol selector per camera. The experimental record-test panel in the UI is kept so we can probe it when the hardware arrives.

2. **Camera goes silent after one pair attempt.** Once the Action 3 accepts a connection (even our rogue one), it stops advertising for a while. Workaround: close Chrome tab, power-cycle camera, retry. Could be fixed by a clean disconnect path (send a disconnect message, release GATT server cleanly). Low priority.

3. **Recording state tracking is command-local.** `session.recording` is only updated from successful start/stop commands. If the user hits the physical shutter on the camera, the UI state goes stale. The status push at `target=0x205` does NOT reflect recording state — confirmed by a 84s capture spanning a real record on/off where not a single byte changed. If we need true state we'd have to find a different status channel. Low priority.

## Bets I'm hedging

- **If the 0x55 protocol truly has no SD record opcode**, the fallback is RTMP-livestream-as-recording: cameras stream to a local SRS server via WiFi, SRS records the streams to file and serves HLS back for live preview. This is bigger work but actually delivers the full use case (sync record + live preview + archived files). Keep it in mind while solving Phase 2.
- **If the Action 3 and Action 4 speak different protocols**, a clean per-session protocol dispatcher is the right architecture rather than forcing one protocol everywhere. Plan for this before writing more code.

## Status log

Append one entry per session. Keep each entry brief — what changed, what we learned, what's next. Link to commits when relevant.

### 2026-04-14 — First BLE handshake success
- Initial project scaffold, PWA shell, GitHub Pages deployment.
- Picked wrong protocol first (0xAA / rhoenschrat) — camera never responded.
- User captured raw notification bytes, saw SOF=0x55, pivoted to node-osmo's 0x55 protocol.
- Fixed CRC init values: pre-reflected from 0xEE/0x496C to 0x77/0x3692 because crc-full reflects internally.
- Added Copy Log / Clear Log buttons for mobile debugging.
- Handshake now works in desktop Chrome against the Action 3. Camera responds on txId 0x8092 and displays a "confirm pairing code" prompt on its screen (not documented in node-osmo — new finding).
- Set up project documentation (CLAUDE.md, README, PROTOCOL, ROADMAP).
- Commits: `init` → `Vendor hls.js` → `Use acceptAllDevices` → `Switch to 0x55 protocol`.
- Next session: log the full byte exchange during a pair-code-accept flow, then start the SD record opcode hunt (lean toward sniffing Mimo on Android).

### 2026-04-14 (later, pt 2) — Field-ready polish + multi-protocol refactor
- Parsed battery % from the status-push channel (offset 20) — now surfaces on each Cam chip and updates as the pack drains. Suppressed the 1 Hz raw log for status pushes to keep the log readable.
- Implemented auto-reconnect on unexpected GATT disconnect: backoff `[0, 2, 5, 15, 30, 60]s` (last value repeats forever). Manual disconnect short-circuits via `session.intentionalDisconnect`. `session.recording` is preserved across drops since the camera keeps recording to SD across BLE loss.
- Refactored the protocol layer into a driver-object interface. `dji55Driver` wraps today's 0x55 codec and message catalog; `dji0xaaDriver` is a stub that throws until an Action 4 is on hand. `CameraSession` constructor now takes a driver and delegates every byte (buildFrame, parseFrame, sof, minFrameLen, decodePush, pairFrame, recordFrame, isRecordOk) to it. `selectDriver({device})` picks by `device.name` regex with 0x55 as the safe fallback.
- Commits: `b073770` (v10 battery) → `0bc9665` (v11 reconnect) → next: v12 driver refactor.
- Next session: Phase 4 (live preview RTMP pipeline) — needs an infrastructure decision before coding.

### 2026-04-14 (later) — Record opcode solved for Action 3
- Ruled out the status-push channel (`target=0x205, type=0x20d00`) as a record-state signal — 84s of captures across a real physical-button record on/off showed not a single byte change related to recording. It's a slow battery/temp heartbeat only.
- Did NOT need to sniff DJI Mimo. Web research turned up the opcode in the DJI DUML dictionary: CmdSet=0x02 / CmdID=0x02 "Do Record", documented in [xaionaro-go/djictl pkg/duml/message_type.go](https://github.com/xaionaro-go/djictl/blob/main/pkg/duml/message_type.go) and [o-gs/dji-firmware-tools dji-dumlv1-camera.lua](https://github.com/o-gs/dji-firmware-tools/blob/master/comm_dissector/wireshark/dji-dumlv1-camera.lua). node-osmo never ported it because it only needed livestream.
- Shipped an experimental test panel (commits 3d3c1af/v7 and f7ba816/v8) that sent candidate frames across 3 target guesses × a few payload variants. Empirical results against the Action 3:
  - `target=0x0802` → all payloads rejected with response `0xe0` (wrong target)
  - `target=0x0202` → frame echoed back with no effect (target unknown)
  - `target=0x0102, payload=empty` → response `0xe3` (right target, missing argument)
  - `target=0x0102, payload=[0x01]` → camera starts SD recording, response `0x00` ✓
  - `target=0x0102, payload=[0x00]` → camera stops SD recording, response `0x00` ✓
- Camera reply uses `target=0x0201` (sender/receiver bytes swapped vs. 0x0102) and `type=0x0202c0` (0x40 flag flipped to 0xc0 = response bit). Payload byte 0 is status: `0x00`=ok, `0xe0`/`0xe3`=various errors.
- Wired `startRecordAll` / `stopRecordAll` in `DJIControl` to real frames with `Promise.all` fan-out. Master Record button now functional against the Action 3.
- Test panel kept in the UI for future Action 4 probing.
- Commits: `3d3c1af` (v7 test harness) → `f7ba816` (v8 stop candidates) → next: v9 wiring.
- Next session: probably Action 4 hardware testing once it arrives, or RTMP live-preview pipeline (Phase 4).
