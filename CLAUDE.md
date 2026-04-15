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
├── package.json                    Root npm project — Capacitor deps only
├── capacitor.config.json           App id, name, webDir='www'
├── .github/workflows/
│   └── android-build.yml           CI → debug APK artifact
├── www/                            PWA source (served via Capacitor WebView)
│   ├── index.html                  App shell (dark, landscape, 2-pane grid)
│   ├── app.js                      UI wiring: pair btn, master record, log panel
│   ├── dji-control.js              BLE protocol layer — CRCs, drivers, CameraSession
│   ├── video-pane.js               hls.js wrapper for the 2 video previews
│   ├── styles.css                  Dark theme, bright red record button, chips
│   ├── manifest.json               PWA manifest (standalone, landscape, dark)
│   ├── sw.js                       Service worker (still useful for web dev loop)
│   ├── vendor/hls.min.js           hls.js 1.5.13, vendored
│   └── icons/                      Placeholder PWA icons
├── android/                        Capacitor-generated Gradle project
│   ├── app/                        android app module
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

### Deployment

7. **Bump `CACHE` in `sw.js:1` on every deploy** (`field-cam-v6` → `v7` → ...). Otherwise the service worker serves stale code forever. The version number also goes in commit messages so we can grep history.

8. **Web Bluetooth requires HTTPS or `http://localhost`**. GitHub Pages is HTTPS so it works. Local `python3 -m http.server 8000` also works via `http://localhost:8000`. A LAN IP like `http://192.168.x.x:8000` will NOT work — the origin isn't considered secure.

9. **`gh` is snap-installed and has a sandboxed git that can't find `git-remote-https`.** Use system `git push` directly, not `gh repo create --push`.

### UI / UX

10. **The log panel has Copy Log + Clear Log buttons** for easy debugging on mobile. Tell the user to use them — they save a huge amount of time vs. transcribing from a phone screen.

11. **Desktop Chrome on Windows works for Web Bluetooth dev.** The user confirmed. Dev loop is: edit → push → Pages rebuild (~30s) → hard refresh desktop Chrome → test. Much faster than mobile.

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

See `docs/ROADMAP.md` for the full picture. As of last session:

- ✅ GitHub Pages deploy working (`https://joz104.github.io/djiapp/`)
- ✅ PWA shell, offline caching, dark theme, dual video panes
- ✅ BLE scanning, connecting, GATT service/char discovery
- ✅ 0x55 protocol frame builder / parser with correct CRCs (validated against real camera frame)
- ✅ Pair handshake works. Camera replies `0x00 0x01` immediately on txId 0x8092 (no PIN-confirmation follow-up frame observed — likely auto-accept once previously paired).
- ✅ **Record-to-SD opcode confirmed on Action 3.** `target=0x0102, type=0x020240, payload=[0x01]` starts recording; `[0x00]` stops. Camera replies on `target=0x0201, type=0x0202c0` with payload `0x00` on success (error codes seen: `0xe0` wrong target, `0xe3` bad arg). Opcode source: DJI DUML CmdSet=0x02 / CmdID=0x02 "Do Record" from xaionaro-go/djictl + o-gs/dji-firmware-tools camera dissector.
- ✅ `startRecordAll` / `stopRecordAll` wired. Master Record button functional against the Action 3.
- ✅ Battery % parsed from status push (offset 20) and shown on Cam chips.
- ✅ Auto-reconnect on BLE drop with backoff `[0, 2, 5, 15, 30, 60]s`, last value repeats. Recording state is preserved across reconnect.
- ✅ **Multi-protocol driver architecture.** `CameraSession` now delegates every byte to `this.driver`. `dji55Driver` handles Action 3; `dji0xaaDriver` is a stub for the Action 4. `selectDriver({device})` picks based on `device.name` regex and falls back to 0x55 as the safe default.
- 🚧 **Status-push channel does NOT reflect recording state** — `target=0x205, type=0x20d00` is a slow battery/temp heartbeat only. Don't rely on it to confirm record state; use the command's own response payload instead.
- ❌ Action 4 — not yet received. The experimental Record opcode test panel in the UI is kept around so we can re-probe target/payload when it arrives.

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
