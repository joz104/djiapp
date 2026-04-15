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

### Phase 4 — live preview pipeline via native Android app ✅
Decided 2026-04-14: pivot off pure-PWA and wrap the app in Capacitor so we can
bundle an on-device RTMP server. Pure PWA can't open raw sockets. Work lives on
the `v2-capacitor` branch; `main` stays as the working Action-3 PWA for
protocol-layer dev iteration.

**Architecture (as shipped)**
- Capacitor wraps the existing PWA as an Android APK (`ca.zorychta.djiapp`,
  Android 35 target).
- Bluetooth via `@capacitor-community/bluetooth-le` v7.3.2 (pinned — v8+ uses
  Kotlin 2.2 which AGP 8.7.2's R8 can't dex without metadata corruption).
  A `BleTransport` abstraction picks `webBluetoothTransport` in the browser
  (for dev on PC) or `capacitorBleTransport` inside the APK at module load.
  The 0x55 driver and CRC layer don't change.
- RTMP server: MediaMTX v1.17.1 (Go binary, MIT, ~27 MB `linux_arm64`)
  downloaded by the GitHub Actions workflow during the build and bundled as
  `android/app/src/main/jniLibs/arm64-v8a/libmediamtx.so`. Extracted into
  `nativeLibraryDir` at install time and exec'd from a foreground service
  (standard "fake .so" workaround for Android Q+ exec-from-private-dir ban).
- Kotlin Capacitor plugin `MediaMtx` (`MediaMtxPlugin.kt` + `MediaMtxService.kt`)
  exposes `start()` / `stop()` / `status()` / `getLocalIps()`. The service is
  a `connectedDevice` foreground service (NOT `mediaProjection` — that type
  requires a real `MediaProjection` consent token on Android 14+).
- Cameras join the tablet's mobile hotspot (no internet needed) via BLE
  `setupWifi`, then RTMP push via BLE `startStreaming` pointed at the
  tablet's IP (`getLocalIps()` picks the 192.168.x.x interface). Preview is
  for setup / framing only; end-to-end latency ~4 seconds.

**Sub-phases (all shipped)**
- [x] **4.0 scaffold** — npm init, Capacitor 8 + Android platform + BLE plugin
      installed, PWA files moved into `www/`, `.gitignore` covering generated
      Android artifacts, GitHub Actions workflow at
      `.github/workflows/android-build.yml` that builds a debug APK on every
      push to `v2-capacitor` (+ manual dispatch). APK published as a rolling
      release on GitHub Releases at `tag=v2-latest` via
      `softprops/action-gh-release@v2`. Commit `7f44904`.
- [x] **4.1 BLE transport swap** — `www/ble-transport.js` with two transports.
      `capacitorBleTransport` talks to `window.Capacitor.Plugins.BluetoothLe`
      directly (no npm wrapper import), converting byte values as lowercase
      hex strings to match the plugin's native bridge (NOT base64 — this cost
      us a session of debugging when the plugin's Kotlin `ConversionKt.toDigit`
      threw `Invalid Hexadecimal Character: V` on base64 data). Eagerly calls
      `ble.initialize({ androidNeverForLocation: true })` on app load so the
      Android 12+ permission prompts fire immediately. Commits `3d32a75`,
      `d5bd952`.
- [x] **4.2 RTMP plugin** — MediaMTX downloaded in CI, bundled via jniLibs.
      Kotlin plugin + foreground service with `connectedDevice` type (NOT
      `mediaProjection` — Android 14+ rejects that type without a real
      projection token). `mediamtx.yml` config in assets copied to
      `filesDir` on first start; RTMP :1935, LL-HLS :8888, two fixed paths
      `cam1` and `cam2`, no API, no auth. Kotlin pinned to 1.9.25 to match
      AGP 8.7.2's R8. Commits `d76bca3`, `a31aab8`.
- [x] **4.3 camera streaming wire-up** — `dji55Driver.setupWifiFrame`,
      `prepareStreamFrame`, `startStreamFrame`, `cleanupStreamFrame`. The full
      state machine from node-osmo `processPairing → processCleaningUp →
      processPreparingStream → processSettingUpWifi`. Timeouts bumped to 30-45s
      because setupWifi takes ~30s while the camera scans + associates + DHCPs.
      `startPreviewAll` fans out per-camera sequential steps in parallel
      across cameras via `Promise.all`. UI: hotspot SSID/pass inputs persisted
      to localStorage, "Start Preview" kicks the full chain, video panes
      auto-load the HLS URLs. No Mimo anywhere. Commits `3516482`, `3bbd469`,
      `98ef7d6`, `7552408`, `06ed50f`, `d0c5a36`, `2527d1b`.

**Confirmed working against Osmo Action 3 hardware** 2026-04-14: pair,
record (start/stop with `CmdSet=0x02/CmdID=0x02`), battery display,
auto-reconnect, Start Preview → camera joins hotspot → camera RTMP push →
MediaMTX LL-HLS → WebView `<video>` renders, Stop Preview → cameras return
to idle, Master Record resumes. **Simultaneous preview + record works** —
the Action 3 accepts `Do Record` while in livestream mode, so the coach can
use the preview as a confidence monitor during the match.

### Phase 5 — UI overhaul, preview quality, stitched view ✅
Post-MVP polish. The v22-era UI was a debug vertical stack of sections. Phase
5 rebuilt it for a landscape tablet on a sideline in daylight, exposed the
preview stream quality as user-selectable, and added a real stitched-preview
view for the two-camera overlap-and-stitch-in-post workflow.

- [x] **5.1 Cleanup + preview settings (cache v22, commit `763db60`)** —
      removed the experimental Record opcode test panel from the UI (the
      `DJIControl.testRecordFrame` method stays in `dji-control.js` for future
      Action 4 probing). Added `<select>` controls for preview resolution
      (480/720/1080p), fps (25/30), bitrate (1/2.5/5/8 Mbps), persisted to
      `localStorage.fmc-preview-{res,fps,br}` and passed into
      `startPreviewAll({resolution, fps, bitrateKbps})`.
- [x] **5.2 UI redesign for landscape field use (cache v23, commit `d79d190`)**
      — `<body>` is now a flex column with a slim topbar, flex-1 main video
      grid, fixed-height record bar, and a thin log bar. The two `<video>`
      elements get absolute-positioned chip overlays for BLE / battery /
      record state on top of each pane. The Master Record button is a big
      red pill at the bottom with a pulsing indicator and a running
      `mm:ss` timer while recording. All setup (hotspot SSID/pass, preview
      quality, paired-cameras list) lives in a right-side slide-in drawer
      accessed via a `Setup` button in the topbar. The log panel collapses
      to a tiny status line at the bottom that expands into a full overlay
      modal on tap. The per-pane URL/Load inputs were removed — preview
      auto-loads the HLS endpoints.
- [x] **5.3 Stitched view toggle (folded into 5.2)** — the `View: Split` /
      `View: Stitched` button in the topbar toggles
      `<main class="grid" data-view="...">` and the CSS rules. In 5.2 this
      was a CSS-only side-by-side layout (two `<video>` elements adjacent).
- [x] **5.4 Canvas-compositing stitched preview (cache v26, commit `60f8904`)**
      — replaces the CSS side-by-side with a real canvas 2D compositor.
      `StitchRenderer` in `app.js` runs a `requestAnimationFrame` loop while
      in stitched mode, reading frames from both `<video>` elements via
      `drawImage` and compositing them into a single wide `<canvas>` using
      a one-time calibration (horizontal FoV + angle between cameras).
      Overlap region is feather-blended by default via an offscreen mask
      canvas + `destination-in` composite with a linear gradient; a "hard
      seam" blend mode toggle lets the user dial in calibration by watching
      where the seam lands. NOT a real homographic stitch — straight lines
      won't stay perfectly straight across the seam — but good enough for
      framing. Calibration persisted to `fmc-stitch-{fov,angle,blend}`.

**Critical bugfixes shipped in Phase 5 (from field logcat diagnosis)**
- `[hidden]{display:none !important}` global override (cache v24, commit
  `13b4450`) — `.log-modal { display: flex }` was winning on specificity
  against the UA `[hidden]` rule, so the ✕ close button "didn't work."
- HLS retry that actually retries (cache v25+v27, commits `210796d`,
  `c65f1bb`) — `VideoPane.load` now passes `manifestLoadingMaxRetry: 20`
  etc. to hls.js, and on fatal `NETWORK_ERROR` runs a full
  destroy+recreate reload loop (not `startLoad()`, which does nothing
  useful on a fatal state). Also added a click-to-play handler on the
  `<video>` elements since the UI redesign dropped the native `controls`
  attribute, and silenced benign `AbortError` from concurrent
  load/play races.

### Phase 6 — remaining polish / ship ❌
- [ ] Hardware verification: confirm SD recording stays at the camera's
      configured resolution (4K) while preview streams at 720p. Simplest
      check is the camera's own on-screen REC indicator; or pull a clip
      off the SD and ffprobe it.
- [ ] Per-camera Y-offset slider for the stitched view, if field testing
      shows tripod-height differences too big for feather blending to mask.
- [ ] Decode the `target=0x208, type=0x3ee80` livestream telemetry push
      (current hypothesis: byte 3 is a segment counter, bytes 6-7 are
      bitrate kbps LE, byte 8 is some flag). A live bitrate chip would
      help the coach notice if the RTMP connection degrades mid-match.
- [ ] Signed release APK: generate a proper keystore, wire it into
      `.github/workflows/android-build.yml` as a repo secret, publish a
      signed APK (or AAB) alongside the debug build. Required before
      Play Store internal testing or direct APK distribution to other
      coaches.
- [ ] Action 4 BLE probe: when hardware arrives, use the
      `DJIControl.testRecordFrame` method (re-exposed behind a dev flag)
      to capture first-notification bytes and determine if it speaks
      0x55 or 0xAA. Fill in `dji0xaaDriver` if needed.
- [ ] Real PWA icons (currently solid-dark placeholders).
- [ ] Haptic feedback on master record tap (`navigator.vibrate(50)`).
- [ ] Decide branch strategy: merge `v2-capacitor` into `main` as the
      shipping branch, or keep both (main = PWA dev loop, v2-capacitor =
      APK shipping).

## Open blockers (priority order)

1. **Action 4 untested.** Hardware not yet received. Don't know whether it
   speaks 0x55, 0xAA, or both, and whether the Action 3's record opcode
   (`0x0102 / 0x020240`) works there. The `dji0xaaDriver` stub exists so we
   can slot in a real driver when we capture the first notification bytes.
   The `testRecordFrame` probe method stays in `dji-control.js` for this.

2. **4K recording verification.** Empirical test pending: does the Osmo
   Action 3 actually record to SD at the body-configured resolution (e.g.
   4K 30) while it's simultaneously streaming RTMP at the preview resolution
   (e.g. 720p), or does livestream mode downgrade the SD recording? User
   to verify by watching the camera's own REC indicator or ffprobing a
   clip pulled from the SD card.

3. **Camera goes silent after one pair attempt.** Once the Action 3 accepts
   a connection, it stops advertising for a while. Workaround: power-cycle
   the camera to re-advertise. Could be fixed by a clean disconnect path
   (explicit disconnect message before releasing the GATT server). Low
   priority.

4. **Recording state tracking is command-local.** `session.recording` is
   only updated on successful start/stop commands. If the user hits the
   physical shutter on the camera, the UI state goes stale. The status
   push at `target=0x205` does NOT reflect recording state — confirmed by
   an 84s capture spanning a real record on/off with no byte changes. If
   we need true state we'd have to find a different status channel. The
   new `target=0x208, type=0x3ee80` push that appears during livestream
   mode (Phase 4.3) is a candidate but hasn't been decoded yet.

5. **Hotspot must be 2.4 GHz.** The Action 3 BLE stack only scans for
   2.4 GHz WiFi during `setupWifi` and fails silently after ~30s with
   response payload `0x01 0xff`. Modern Android phones default their
   mobile hotspot to 5 GHz or "auto" (which prefers 5 GHz). The UI hint
   in the setup drawer says "2.4 GHz" but users will forget — worth
   calling out on first-run or in a welcome screen.

## Bets I'm hedging

- **If the Action 4 turns out to support 0x55 too** we're done — same
  driver, same opcodes. If it only speaks 0xAA (rhoenschrat's protocol),
  we need a second driver. The architecture supports either outcome
  with zero changes to `CameraSession`.
- **If the canvas stitcher isn't good enough visually** (Phase 5.4), the
  next step is per-camera Y-offset + possibly a barrel dewarp shader.
  We'd switch from canvas 2D to WebGL for that; not in scope yet.

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

### 2026-04-15 — Phase 5 polish: UI overhaul, preview settings, canvas stitched view
- **Preview quality selects (v22, `763db60`)** — dropped the experimental Record
  opcode test panel, added resolution / fps / bitrate dropdowns persisted to
  localStorage and wired into `startPreviewAll({resolution,fps,bitrateKbps})`.
  The param path already existed in `dji55Driver.startStreamFrame`; just
  needed real values instead of undefined defaults.
- **UI redesign (v23, `d79d190`)** — full restructure of `index.html` +
  `styles.css` into a landscape-first flex column: slim topbar, flex-1 video
  grid with overlay chips, big red Master Record pill at the bottom, right-side
  setup drawer for hotspot creds + preview quality + paired cameras, collapsed
  log bar that expands into a modal overlay on tap. Master Record button
  now shows a running `mm:ss` timer via setInterval.
- **Stitched view CSS + canvas**
  - v23 shipped a CSS `data-view="stitched"` toggle that just placed the two
    video elements edge-to-edge with a dashed seam.
  - v26 (`60f8904`) replaced that with a real canvas 2D compositor:
    `StitchRenderer` reads frames from both `<video>` elements via
    `drawImage`, computes the overlap from
    `(FoV − angleDeg) / FoV` of the source width, and blends with a feathered
    alpha ramp or a hard seam. Not a real homographic stitch but good enough
    for framing on a static tripod. Calibration persisted under
    `fmc-stitch-{fov,angle,blend}`.
- **Bugs caught and fixed live via adb logcat**
  - Close ✕ on the log modal "didn't work" (v24, `13b4450`): class selector
    `.log-modal { display: flex }` was winning on CSS specificity against
    `[hidden]{display:none}`. Fix: global `[hidden]{display:none !important}`.
  - Live preview "didn't play" (v25, `210796d`): hls.js's internal retry
    budget doesn't cover the 10-30s window while MediaMTX waits for the
    camera to start publishing; `VideoPane.load` now cranks
    `manifestLoadingMaxRetry` etc. up to 20 and schedules a full
    destroy+recreate reload on fatal errors.
  - Live preview STILL didn't play (v27, `c65f1bb`): my network-error
    handler called `hls.startLoad()` and returned, but `startLoad()` on a
    fatal state doesn't recover — it sits dead forever. Fix: drop the
    `startLoad()` fast-path, always schedule a full reload. Also added a
    click-to-play handler on `<video>` since the UI redesign dropped the
    native controls bar.
- **Docs gap**: ROADMAP and CLAUDE.md drifted significantly during the long
  Phase 4 + Phase 5 sessions because each commit was chasing a live bug.
  This status log entry is the consolidation.
- Next: verify v27 live preview on hardware, decide on signed-release
  tooling, decode the `0x3ee80` livestream telemetry push.

### 2026-04-14 (later, pt 4) — Phase 4 implementation: BLE transport swap, MediaMtx plugin, self-contained preview
- **BLE transport swap (v13, `3d32a75`)** — added `www/ble-transport.js` with
  two concrete transports. `capacitorBleTransport` talks to
  `window.Capacitor.Plugins.BluetoothLe` directly (no npm wrapper import to
  avoid needing a bundler). Chose v7.3.2 of `@capacitor-community/bluetooth-le`
  pinned in `package.json` — v8+ is compiled with Kotlin 2.2 which AGP 8.7.2's
  R8 can't dex without corrupting Kotlin metadata (got ~1900
  "Unexpected error during rewriting of Kotlin metadata" D8 warnings on the
  first attempt). Kept Kotlin 1.9.25 to match.
- **Capacitor BLE bridge uses hex strings, not base64 (v13 hotfix, `d5bd952`)**
  — first APK crashed immediately on the pair frame write with
  `java.lang.IllegalArgumentException: Invalid Hexadecimal Character: V` in
  `ConversionKt.toDigit`. The plugin's native bridge expects byte values as
  lowercase hex strings, not base64. Wrote `uint8ToHex` / `hexToUint8` in
  `ble-transport.js` and swapped the encoding.
- **MediaMtx plugin (v13, `d76bca3`)** — Kotlin plugin + foreground service.
  GHA workflow downloads MediaMTX v1.17.1 `linux_arm64`, drops it into
  `android/app/src/main/jniLibs/arm64-v8a/libmediamtx.so`. The service exec's
  the binary from `nativeLibraryDir`, pipes stdout/stderr into Logcat, and
  shows a persistent `connectedDevice` foreground notification. Initially
  used `mediaProjection` FGS type which Android 14+ rejects unless you hold
  a real `MediaProjection` consent token; swapped to `connectedDevice`
  (hotfix `a31aab8`) which only needs `BLUETOOTH_CONNECT` (we already have
  it). `getLocalIps()` plugin method returns all non-loopback IPv4 addrs so
  the UI can pick the tablet's hotspot IP.
- **Self-contained live preview (v15, `3bbd469`)** — wired
  `setupWifiFrame` / `startStreamFrame` / `cleanupStreamFrame` /
  `prepareStreamFrame` in `dji55Driver` per node-osmo's
  `processPairing → processCleaningUp → processPreparingStream →
  processSettingUpWifi` state machine. Several payload bugs burned through
  before the camera accepted things:
  - Initially skipped `cleanupStreamFrame` and `prepareStreamFrame`; camera
    silently ignored `setupWifi` because it was in the wrong state. Fixed
    by walking the full state machine.
  - `prepareStreamFrame` payload is `[0x1a]` (magic byte), not empty. An
    empty payload returned response `0xda` (error) and subsequent commands
    got dropped.
  - 5s/15s timeouts were too short — the camera takes ~30s to associate
    with the hotspot during `setupWifi`. Bumped all stream-state timeouts
    to 30-45s. (`d0c5a36`)
  - Critically: **Action 3 only supports 2.4 GHz WiFi**. On 5 GHz hotspot
    (the Android default) the camera returns response `01 ff` after ~30s.
    Worked once the user switched the hotspot band. (`2527d1b`)
- **CI: GitHub Releases for APKs (`caae796`)** — modified the workflow to
  create/update a rolling release at tag `v2-latest` with the APK attached,
  so install-on-phone is a single tap from
  https://github.com/joz104/djiapp/releases/tag/v2-latest instead of
  unzipping a workflow artifact.
- **Wireless adb setup** — for runtime debugging. `adb pair` + `adb connect`
  over WiFi works cleanly from WSL (TCP only, no USB passthrough). Gotcha:
  the pairing-code port closes the instant you navigate away from the
  "Pair device with pairing code" screen on the phone; must paste the
  `IP:port` + pin while the dialog is still visible.
- **`adb logcat | grep FMC`** — `app.js`'s `log()` now mirrors to
  `console.log`/`warn`/`error` tagged `[FMC:kind]` so Android pipes the
  lines into Logcat under `Capacitor/Console`, making field debugging
  grep-able instead of copy-paste from the UI panel.
- **End-to-end confirmed on real hardware**: pair, record, Start Preview,
  Stop Preview, simultaneous preview+record all working without Mimo.
- Next: UI polish, preview quality selects, real stitched view (Phase 5).

### 2026-04-14 (later, pt 3) — Phase 4 pivot, Capacitor scaffold landed on v2-capacitor
- Decided to wrap the app in Capacitor rather than defer Phase 4. Research confirmed: Android WebView still has no Web Bluetooth in 2026 (Chromium #1100993), so the PWA's BLE code must be ported onto `@capacitor-community/bluetooth-le` inside the wrap. The driver refactor from earlier today pays off here — only the transport layer needs to swap, not the protocol code.
- MediaMTX is the chosen RTMP server: Go binary, ~27 MB, official `linux_arm64` build, MIT license, RTMP in + native LL-HLS out (no ffmpeg transmux). Bundling strategy: drop it into `jniLibs/arm64-v8a/libmediamtx.so` and exec from `nativeLibraryDir` — standard Android Q+ workaround for the exec-from-app-dir ban.
- Scaffolded Capacitor on the `v2-capacitor` branch: `npm init`, installed `@capacitor/core`, `@capacitor/cli`, `@capacitor/android`, `@capacitor-community/bluetooth-le`. `npx cap init` with app id `ca.zorychta.djiapp` and web dir `www`. Moved all PWA files into `www/`. `npx cap add android` generated the Gradle project. GitHub Actions workflow at `.github/workflows/android-build.yml` builds a debug APK on every push to `v2-capacitor` and is manually dispatchable, producing `field-multicam-debug-apk` as a workflow artifact. No local Android Studio needed.
- Next: phase 4.1 BLE transport swap.

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
