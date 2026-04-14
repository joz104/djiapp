# vendor/

Local copies of third-party libraries. Nothing here is fetched from a CDN at runtime — the tablet is assumed to be offline in the field.

## hls.min.js (REQUIRED)

Download once (with internet) and save as `vendor/hls.min.js`:

    curl -L -o hls.min.js https://cdn.jsdelivr.net/npm/hls.js@1.5.13/dist/hls.min.js

Or open that URL in a browser and "Save As". Version 1.5.13 is known-working; newer 1.5.x releases should also work.

After placing the file here, hard-reload the app to let the service worker pick it up into the precache.
