# Field Multi-Cam Controller

A Progressive Web App that triggers synchronized Start/Stop Recording on two DJI Osmo Action cameras (Action 3 and Action 4) over Web Bluetooth, from an Android tablet on a soccer sideline.

**Live**: https://joz104.github.io/djiapp/

## What it does

- Pairs with DJI Osmo Action cameras via Web Bluetooth (no DJI Mimo app, no physical remote).
- Shows two simultaneous live previews (HLS; RTMP via a restreamer).
- Fires synchronized record start/stop on both cameras from a single "Master Record" button.
- Installs to the Android home screen as a PWA and runs fully offline after the first load.

## Hardware

| Camera | Status |
|---|---|
| DJI Osmo Action 3 | Active target. BLE handshake working over the `0x55` (node-osmo) protocol. |
| DJI Osmo Action 4 | Not yet on hand. May speak a different protocol dialect — TBD. |

Plus: Android tablet running Chrome, ideally in a sideline mount with a tablet-based Wi-Fi hotspot if we add the live-preview pipeline.

## Architecture

Vanilla JS, no build step. ES modules. All dependencies vendored locally under `vendor/` so the tablet works without internet at the field.

```
index.html       App shell
app.js           UI wiring (pair button, master record, log panel)
dji-control.js   BLE protocol layer — CRCs, frame builder, pair handshake
video-pane.js    hls.js wrapper for the two preview panes
sw.js            Service worker (cache-first, offline shell)
manifest.json    PWA manifest
vendor/hls.min.js  hls.js 1.5.13
icons/           PWA icons
docs/
  PROTOCOL.md    BLE protocol deep-dive
  ROADMAP.md     Phases, current state, blockers
```

## Quickstart (development)

```bash
git clone git@github.com:joz104/djiapp.git
cd djiapp
python3 -m http.server 8000
# Open http://localhost:8000 in Chrome (desktop or Android — both work)
```

Web Bluetooth requires HTTPS OR `http://localhost`. A LAN IP will NOT work — Chrome doesn't treat it as a secure origin.

**Dev loop**: edit → `git push` → GitHub Pages auto-deploys (~30s) → hard refresh Chrome → test via "+ Pair Camera" → copy log from the log panel → iterate.

**Critical**: bump `CACHE` in `sw.js` on every code change (e.g. `'field-cam-v6'` → `'field-cam-v7'`). Otherwise the service worker serves stale code.

## Deployment

GitHub Pages auto-deploys on push to `main`. Deploy status at https://github.com/joz104/djiapp/actions.

To install on a tablet:

1. Open https://joz104.github.io/djiapp/ in Chrome on the tablet (needs internet the first time).
2. Chrome menu → **Install app** / **Add to Home Screen**.
3. The service worker caches the whole shell. After first load, it works offline.
4. To update: open the app on any Wi-Fi, Chrome will pull the new version in the background.

## Development references

- [datagutt/node-osmo](https://github.com/datagutt/node-osmo) — TypeScript reference implementation (MIT) of the `0x55` protocol. The source of truth for frame layout, pair handshake, and RTMP livestream opcodes.
- [eerimoq/moblin](https://github.com/eerimoq/moblin) — Swift upstream of node-osmo, may have code node-osmo omitted.
- [rhoenschrat/DJI-Remote](https://github.com/rhoenschrat/DJI-Remote) — ESP32 remote using the `0xAA` protocol (different flavor). Useful once we test the Action 4.
- [dji-sdk/Osmo-GPS-Controller-Demo](https://github.com/dji-sdk/Osmo-GPS-Controller-Demo) — DJI's own ESP32 reference for the `0xAA` protocol.

## Status

Pre-v1. See [docs/ROADMAP.md](docs/ROADMAP.md) for phases and open blockers. The short version: BLE handshake is working on the Action 3; record command is blocked on finding the right opcode.

## License

No license yet — private project.
