# Roadmap

Phases, current state, and open blockers. The status log at the bottom is the running history of what changed per session — append new entries, don't rewrite old ones.

## Phases

### Phase 0 — project setup ✅
- [x] Vanilla JS + ES modules, no build step
- [x] PWA shell, manifest, service worker, dark theme
- [x] hls.js vendored locally for offline use
- [x] GitHub Pages deploy (https://joz104.github.io/djiapp/)
- [x] Project documentation (CLAUDE.md, README, PROTOCOL, ROADMAP)

### Phase 1 — BLE handshake 🚧
- [x] Service/characteristic discovery (FFF0 / FFF3 / FFF4 / FFF5)
- [x] Scan without service filter (`acceptAllDevices` — Action 3 doesn't advertise FFF0)
- [x] 0x55 protocol frame builder and parser with correct CRCs
- [x] Notification reassembly (`CameraSession.onNotification`)
- [x] Pair message sent, camera responds
- [x] Camera prompts for pairing code confirmation on its screen
- [ ] Handle the post-code-confirmation flow — what frames arrive after accept?
- [ ] Persist "already paired" state so subsequent sessions skip the code prompt
- [ ] Test reconnect after disconnect

### Phase 2 — record control ❌
- [ ] **Find the SD record start/stop opcode.** node-osmo doesn't have it. Options:
  - Sniff DJI Mimo over Bluetooth HCI snoop log (~30 min on Android)
  - Grep `eerimoq/moblin` (Swift upstream) for `record`, `REC`, `shutter`, `capture`
  - Decode the camera's periodic status push and watch which bits change when the user manually presses the shutter on the camera
- [ ] Implement `startRecord()` and `stopRecord()` in `CameraSession`
- [ ] Wire `startRecordAll` / `stopRecordAll` fan-out in `DJIControl` (currently stubs)
- [ ] Measure end-to-end latency between the two cameras when both are triggered

### Phase 3 — second camera (Action 4) ❌
- [ ] Receive Action 4 hardware
- [ ] Capture raw BLE notification bytes to determine which protocol it speaks (0x55 vs 0xAA)
- [ ] If it speaks 0xAA, port rhoenschrat's frame builder as a second implementation
- [ ] Multi-protocol architecture — each `CameraSession` knows which protocol its camera speaks
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

1. **Post-pair-code flow unknown.** The Action 3 prompts for a pairing code confirmation on its screen after we send the pair message. What happens next? Need a full log from a pair attempt where the user taps accept. This unblocks reconnects and clean handshake.

2. **SD record opcode unknown.** node-osmo has zero record-to-SD code. Three paths forward (sniff Mimo / grep moblin / decode status push). The sniff-Mimo path is probably fastest — user has Android, a 30-minute Wireshark session likely yields the exact bytes.

3. **Action 4 untested.** Don't know yet whether it speaks 0x55, 0xAA, or both. May require a second frame builder + protocol selector per camera.

4. **Camera goes silent after one pair attempt.** Once the Action 3 accepts a connection (even our rogue one), it stops advertising for a while. Workaround: close Chrome tab, power-cycle camera, retry. Could be fixed by a clean disconnect path (send a disconnect message, release GATT server cleanly). Low priority.

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
