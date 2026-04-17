# CLAUDE.md

Auto-loaded project context. Read this before doing anything in this repo.

## What this project is

A Web Bluetooth PWA that triggers synchronized Start/Stop Recording on two DJI Osmo Action cameras (Action 3 and Action 4) from an Android tablet on a soccer sideline. Vanilla JS, no build step. Hosted on GitHub Pages, fully offline-capable after first load.

- **Live**: https://joz104.github.io/djiapp/
- **Repo**: https://github.com/joz104/djiapp
- **Owner**: joz104 (john@zorychta.ca)
- **Use case**: youth soccer coach, sideline dual-cam recording

## Branch model

- **`main`** — pure PWA, works on any modern Chromium-based browser with Web Bluetooth (desktop Chrome, Chrome for Android via `https://joz104.github.io/djiapp/`). This is the dev-loop branch for protocol work on the Osmo Action 3 because desktop Chrome is the fastest way to iterate on BLE.
- **`v2-capacitor`** — pivot to a full Android app wrapped in Capacitor, with an on-device MediaMTX RTMP server for live preview. Work in progress; see `docs/ROADMAP.md` Phase 4. The PWA files live under `www/` on this branch. Android project under `android/`. Built via `.github/workflows/android-build.yml` on every push; debug APK downloadable as a workflow artifact. Local build possible with Android Studio + JDK 21.

## File map (v2-capacitor branch)

```
djiapp/
├── package.json                    Root npm project — pinned
│                                   @capacitor-community/bluetooth-le@7.3.2
│                                   (v8+ uses Kotlin 2.2 and breaks dex)
├── capacitor.config.json           App id, name, webDir='www'
├── .github/workflows/
│   └── android-build.yml           CI → debug APK artifact → rolling release
│                                   at tag v2-latest on GitHub Releases
├── www/                            PWA source (served via Capacitor WebView)
│   ├── index.html                  App shell, landscape, flex column layout
│   │                               (topbar, video grid, record pill, log bar,
│   │                                right-slide setup drawer, log modal)
│   ├── app.js                      UI wiring: pair, master record timer,
│   │                               preview flow, view mode toggle, log
│   │                               modal, setup drawer, StitchRenderer
│   ├── dji-control.js              Protocol layer: CRCs, drivers, opcodes,
│   │                               startRecordAll / startPreviewAll /
│   │                               stopPreviewAll, status-push parser
│   ├── ble-transport.js            Web Bluetooth <-> Capacitor BLE plugin
│   │                               swappable transport; chosen at load via
│   │                               window.Capacitor.isNativePlatform()
│   ├── video-pane.js               hls.js wrapper with auto-reload loop,
│   │                               click-to-play fallback, per-pane state
│   ├── styles.css                  Dark theme, flex-column layout,
│   │                               split/stitched grid rules
│   ├── manifest.json               PWA manifest (standalone, landscape, dark)
│   ├── sw.js                       Service worker — cache-first, bump every
│   │                               deploy (currently field-cam-v27)
│   ├── vendor/hls.min.js           hls.js 1.5.13, vendored
│   └── icons/                      Placeholder PWA icons
├── android/                        Capacitor-generated Gradle project
│   ├── app/
│   │   ├── build.gradle            Kotlin 1.9.25, AGP 8.7.2, useLegacyPackaging
│   │   ├── src/main/
│   │   │   ├── AndroidManifest.xml Permissions (BLE + foreground service),
│   │   │   │                       MediaMtxService declaration
│   │   │   ├── assets/mediamtx.yml RTMP:1935 in, LL-HLS:8888 out, 2 paths
│   │   │   └── java/ca/zorychta/djiapp/
│   │   │       ├── MainActivity.java       Registers MediaMtxPlugin
│   │   │       ├── MediaMtxPlugin.kt       @CapacitorPlugin MediaMtx
│   │   │       └── MediaMtxService.kt      Foreground service, exec's
│   │   │                                    libmediamtx.so from nativeLibraryDir
│   │   └── (jniLibs/arm64-v8a/libmediamtx.so is downloaded in CI, not
│   │    committed — keep the repo lean)
│   ├── gradlew, gradlew.bat        Gradle wrapper
│   └── ...
├── docs/
│   ├── PROTOCOL.md                 BLE protocol deep-dive
│   └── ROADMAP.md                  Phases, current state, blockers, status log
└── CLAUDE.md                       This file
```

## Critical gotchas

**These have already bitten us — don't re-learn them the hard way.**

### BLE protocol

1. **The Osmo Action 3 speaks the `0x55` protocol (node-osmo / Moblin), NOT the `0xAA` protocol (rhoenschrat / GPS Remote).** We initially ported the 0xAA flavor and the camera never responded. Confirmed by capturing notification bytes: `55 2f 04 63 ...`. Action 4 is untested and may be different. See `docs/PROTOCOL.md`.

2. **CRC init values must be PRE-reflected.** node-osmo declares `init=0xEE` for CRC8 and `init=0x496C` for CRC16, but the `crc-full` library bit-reverses these internally when `refIn=true`. Hand-rolled reflected-table implementations must use `0x77` and `0x3692` directly. This was validated against a real captured camera frame (expected CRC8=0x63, CRC16=0x2b44).

3. **`acceptAllDevices: true` is required for `requestDevice`**. The Action 3 does not advertise service `0xFFF0` in its scan response — only its BLE device name. A service filter returns zero results. List `DJI_SERVICE` in `optionalServices` so we can access it after connection.

4. **Use `writeValueWithoutResponse` for commands.** Matches node-osmo's behavior. Falls back to `writeValue` if unsupported.

5. **Subscribe to BOTH `FFF4` and `FFF5`**. Some frame types arrive on one, some on the other.

6. **Notifications are reassembled by `CameraSession.onNotification`** — multi-notification frames are merged by the SOF+totalLen accumulator. Don't try to parse a single notification as a single frame.

### Capacitor / Android build

7. **Pin `@capacitor-community/bluetooth-le` to 7.3.2**, not v8+. v8 is
   compiled with Kotlin 2.2.0 which AGP 8.7.2's bundled R8 (8.7.x) can't
   dex — it emits ~1900 "Unexpected error during rewriting of Kotlin
   metadata" warnings and the resulting APK crashes at first BLE call.
   Matching Kotlin 1.9.25 in `android/build.gradle` keeps the whole
   stack aligned.

8. **Capacitor BLE native bridge wants hex strings, NOT base64.** The
   plugin's Kotlin `ConversionKt.stringToBytes` expects lowercase hex
   for `write`/`writeWithoutResponse` `value` params and returns hex on
   `notification` events. Sending base64 crashes with
   `java.lang.IllegalArgumentException: Invalid Hexadecimal Character`.
   `ble-transport.js:uint8ToHex` / `hexToUint8` handle the conversion.

9. **MediaMTX foreground service must be `connectedDevice` type, not
   `mediaProjection`.** Android 14+ rejects `mediaProjection` without a
   real `MediaProjection` consent token (which is for screen capture,
   not RTMP ingest). `connectedDevice` accepts services that interact
   with BLE peripherals and only needs `BLUETOOTH_CONNECT`, which we
   already have. Set via `android:foregroundServiceType="connectedDevice"`
   in `AndroidManifest.xml` and `ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE`
   in `MediaMtxService.startForeground()`.

10. **Osmo Action 3 livestream flow is a strict state machine**:
    `stopStreaming (cleanup) → preparingToLivestream → setupWifi → startStreaming`.
    Skipping any step silently freezes the camera. The
    `preparingToLivestream` payload is a magic **single byte `0x1a`**,
    NOT empty (empty gets response `0xda` error).

11. **Action 3 only supports 2.4 GHz WiFi.** `setupWifi` returns error
    `0x01 0xff` after ~30s if the phone's hotspot is on 5 GHz. Modern
    Android phones default to 5 GHz or "auto". UI hint tells users to
    switch to 2.4 GHz explicitly.

12. **Stream-flow timeouts need to be generous.** The camera takes
    5-30s per step to physically switch modes, associate with WiFi,
    and open the RTMP TCP connection. `prepareStream`/`setupWifi` are
    30s, `startStream` is 30s in `dji-control.js:dji55Driver`.

13. **hls.js `startLoad()` on a fatal error does nothing useful.** After
    a fatal `manifestLoadError` the hls.js instance is dead; only a
    full `hls.destroy()` + new `new Hls(...)` recovers. `VideoPane.load`
    does this via `_scheduleReload` on any fatal error.

14. **Bump `CACHE` in `www/sw.js:1` on every deploy**
    (`field-cam-v22` → `v23` → ...). The Capacitor WebView's service
    worker persists across APK installs and will serve stale JS/HTML
    if you don't bump the cache version. The version goes in commit
    messages so we can grep history.

15. **Global `[hidden]{display:none !important}` in `styles.css`**. Class
    selectors with `display:flex/block` win on specificity over the UA
    `[hidden]{display:none}` rule, which burns you the moment you
    `element.hidden = true` and see nothing happen. Always use
    `!important` on the `[hidden]` override.

### Deployment

16. **Web Bluetooth requires HTTPS or `http://localhost`**. GitHub Pages
    is HTTPS so the `main` PWA works. Local `python3 -m http.server 8000`
    works via `http://localhost:8000`. A LAN IP like
    `http://192.168.x.x:8000` will NOT work — the origin isn't secure.
    Capacitor WebView uses `https://localhost` internally so same rule
    applies there.

17. **APKs are published as a rolling GitHub Release** at
    `https://github.com/joz104/djiapp/releases/tag/v2-latest`. Every push
    to `v2-capacitor` updates `field-multicam-latest.apk`. Install path
    for users: open the URL on phone → tap APK → install (one-time
    "allow unknown apps" grant on first install). No adb needed for
    regular installs.

18. **`gh` CLI is snap-installed in WSL** and has a sandboxed git that
    can't find `git-remote-https`. Use system `git push` directly,
    not `gh repo create --push`.

### 0xAA R-SDK protocol (Action 4)

23. **Action 4 speaks 0x55 for pair but 0xAA for commands.** Pair handshake
    uses the same 0x55 pair frame as Action 3. But record, mode switch,
    and status push all use the 0xAA R-SDK protocol. The `_recordFanOut`
    method auto-detects: tries 0x55 first (1.5s timeout), falls back to
    0xAA. Protocol cached per session as `_recordProtocol`.

24. **0xAA writes go to FFF5, not FFF3.** The 0x55 protocol writes to
    FFF3. The 0xAA protocol writes to FFF5. Writing 0xAA frames to FFF3
    is silently ignored — the camera never even sees them. This cost us
    an entire debug cycle.

25. **0xAA CRC init is 0x3AA3, not standard.** Both CRC16 and CRC32 use
    DJI-custom init value `0x3AA3`. The polynomials and reflection are
    standard (CRC16: poly 0x8005 reflected, CRC32: poly 0x04C11DB7
    reflected), but standard MODBUS (init 0xFFFF) or standard CRC32
    (init 0xFFFFFFFF) produce WRONG checksums. CRC32 also has NO final
    XOR (standard CRC32 does `^ 0xFFFFFFFF`).

26. **0xAA version field = 0.** The ver/length field at bytes [1-2] uses
    bits [15:10] for version, [9:0] for length. Version must be 0
    (not 1). DJI SDK docs confirm "default value 0".

27. **0xAA handshake (CmdSet=0x00/CmdID=0x19) is mandatory.** Camera
    silently ignores ALL 0xAA commands until the 4-step connection
    handshake completes. Steps: (1) we send connection request with
    verify_mode=1, (2) camera responds, (3) camera sends its own
    connection request with verify_mode=2, (4) we ACK using camera's
    SEQ number. Implemented in `_aaHandshake()`, runs automatically on
    first 0xAA command per session.

28. **Mode switch "reserved" bytes are magic `[0x01, 0x47, 0x39, 0x36]`.**
    Not zeros. Both DJI SDK docs and rhoenschrat use this value.

29. **Action 4 BLE name is user-customizable.** Our Action 4 advertises
    as "johnzorychta2" (the phone name from DJI Mimo pairing), NOT
    "Action 4" or "OA4". Don't rely on device name for model detection.
    The device info push (`type=0x810040`) contains model "ac203".

### Debugging

19. **`adb logcat | grep FMC`** is the debug channel. `app.js:log()` mirrors
    every in-app log message to `console.log`/`warn`/`error` tagged
    `[FMC:kind]` so Android pipes them into Logcat under
    `Capacitor/Console`. Much faster than hand-copying from the UI
    log panel.

20. **Wireless adb over WiFi works from WSL** without USB passthrough.
    Pair once via Settings → Developer options → Wireless debugging →
    Pair device with pairing code, then `adb pair IP:PORT` + six-digit
    code while the pairing dialog is still visible (the port closes the
    moment you navigate away). After that `adb connect IP:PORT` against
    the main Wireless debugging port (different from the pairing port).

### UI / UX

21. **The log panel lives behind a collapsed bar at the bottom**. Tap it
    to open the modal overlay with Copy Log + Clear Log + ✕. Not as
    discoverable as the old top-level buttons — worth mentioning to
    new users.

22. **Desktop Chrome on Windows works for Web Bluetooth dev.** Dev loop
    on `main`: edit → push → Pages rebuild (~30s) → hard refresh Chrome
    → test. Still useful for protocol-layer changes even though
    Phase 4+ lives on `v2-capacitor`.

## Conventions

- **No framework, no build step.** ES modules, vanilla JS. Don't introduce Vite / React / bundlers without asking.
- **No new documentation files without asking.** The files in `docs/` are fixed — extend them, don't add new ones.
- **Service worker cache bump on every code change.** Include the new version in the commit message so it's easy to find.
- **All dependencies vendored under `vendor/`**, no CDN calls at runtime. The tablet must work offline once installed.
- **Don't add emojis** unless the user asks.
- **Log panel entries** use `log(kind, msg)` where kind is `'ok' | 'warn' | 'err'`. Hex dumps go through the `hex()` helper in `dji-control.js`.

## How to iterate

### On `main` (PWA dev loop)
1. Edit files at repo root.
2. `git add -A && git commit -m "…" && git push` — GitHub Pages auto-deploys.
3. Hard-refresh Chrome (or close/reopen tab) to pick up the new service worker.
4. Test via "+ Pair Camera" → paste the log → iterate.

### On `v2-capacitor` (Android app dev loop)
1. Edit files under `www/` the same way. The Capacitor project treats `www/` as the web root, so protocol-layer changes are still fast-iterated in a browser by serving `www/` locally (`cd www && python3 -m http.server 8000` then open `http://localhost:8000`).
2. For an APK build: `git push` — the GitHub Actions workflow builds a debug APK within ~5 min and uploads it as an artifact named `field-multicam-debug-apk`. Download, sideload via `adb install app-debug.apk`. Alternative: build locally with Android Studio + JDK 21 (`cd android && ./gradlew :app:assembleDebug`).
3. `npx cap sync android` after changing `www/` files IF you're building locally — copies `www/` into the Android assets directory. The GitHub Action does this automatically.

## Current state (keep this updated)

See `docs/ROADMAP.md` for the full picture. As of 2026-04-16:

**Shipped and working on BOTH Action 3 and Action 4 hardware:**
- ✅ Capacitor APK build via GHA → rolling GitHub Release at `v2-latest`
- ✅ BLE pair handshake via Capacitor BLE plugin (hex-string bridge)
- ✅ Auto-reconnect on BLE drop with `[0, 2, 5, 15, 30, 60]s` backoff,
      recording state preserved across the drop
- ✅ Battery % displayed on each camera's chip overlay
- ✅ Master Record button: `startRecordAll` / `stopRecordAll` fan-out with
      `Promise.all`, running `mm:ss` timer while active, optimistic UI with
      rollback on camera reject
- ✅ **Dual-protocol recording**: Action 3 uses 0x55 (CmdSet=0x02/CmdID=0x02),
      Action 4 uses 0xAA R-SDK (CmdSet=0x1D/CmdID=0x03). Auto-detected on
      first record: tries 0x55 with 1.5s timeout, falls back to 0xAA with
      full handshake. Protocol cached per session for instant subsequent use.
- ✅ **0xAA connection handshake** (CmdSet=0x00/CmdID=0x19, 4-step) runs
      automatically before any 0xAA command. Required — camera ignores 0xAA
      frames without it.
- ✅ **Mode switching** (Action 4 only): CmdSet=0x1D/CmdID=0x04. Tappable
      mode chip on each camera pane cycles Video/Photo/Slow-Mo/Timelapse/
      Hyperlapse. Not available on Action 3 via BLE.
- ✅ **0xAA status push** (Action 4): 38-byte push at 2Hz with camera mode,
      recording state, battery, remaining storage. Much richer than the 0x55
      status push.
- ✅ **Multi-camera persistence**: all paired cameras saved to localStorage
      with stable slot assignments. Auto-reconnects all saved cameras on app
      launch. Camera names shown on video pane labels.
- ✅ Live preview end-to-end (Action 3 only — untested on Action 4)
- ✅ UI redesign (v23): slim topbar, video grid with overlay chips,
      big red Master Record pill, right-slide setup drawer, collapsed log bar
- ✅ Stitched view toggle with canvas 2D compositor (v26)

**Action 3 vs Action 4 — what works on which:**
| Feature | Action 3 | Action 4 |
|---|---|---|
| BLE pair (0x55) | ✅ | ✅ |
| Record start/stop | ✅ (0x55) | ✅ (0xAA) |
| Mode switch (Video/Photo/etc) | ❌ not via BLE | ✅ (0xAA) |
| Status push (battery, mode, rec state) | ✅ (0x55, battery only) | ✅ (0xAA, full) |
| Live preview (RTMP) | ✅ | ❌ untested |
| WiFi setup (setupWifi) | ✅ | ❌ untested |

**Open / partially done:**
- 🚧 **Stitched view untested with two real cameras**
- 🚧 **4K SD recording during livestream** — unverified on Action 3
- 🚧 **Live preview on Action 4** — the 0x55 stream commands may not work;
      Action 4 may need 0xAA equivalents for WiFi/stream setup
- ❌ **Signed release APK** — all current builds are debug-signed

## Reference repos (in priority order)

1. **[datagutt/node-osmo](https://github.com/datagutt/node-osmo)** — primary reference. TypeScript. Frame builder in `src/message.ts`, state machine + opcode constants in `src/device.ts`. MIT licensed. Handles pair + RTMP livestream. **No SD record opcodes.**
2. **[eerimoq/moblin](https://github.com/eerimoq/moblin)** — Swift upstream of node-osmo. May have code node-osmo dropped. Check here before assuming something isn't reverse-engineered.
3. **[rhoenschrat/DJI-Remote](https://github.com/rhoenschrat/DJI-Remote)** — ESP32 remote using the DIFFERENT `0xAA` protocol. Has record opcodes for Action 4/5/6. **Wrong protocol for Action 3.** Reference only for Action 4 once we test it.
4. **[dji-sdk/Osmo-GPS-Controller-Demo](https://github.com/dji-sdk/Osmo-GPS-Controller-Demo)** — DJI's own ESP32 reference for the `0xAA` protocol.

## When in doubt

- Check `docs/PROTOCOL.md` before re-researching anything BLE-related.
- Check `docs/ROADMAP.md` for what we've tried and what's still open.
- Check git log for the exact sequence of decisions.
- Ask the user to paste a log from Copy Log rather than guessing.
