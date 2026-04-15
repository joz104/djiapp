// VideoPane — thin wrapper around a <video> element with hls.js support.
// Note: browsers cannot play RTMP directly. If the user pastes an rtmp:// URL,
// we log a clear error explaining they must restream as HLS (e.g. via nginx-rtmp
// or SRS running on the tablet hotspot router).

export class VideoPane {
  constructor(videoEl, paneId) {
    this.videoEl = videoEl;
    this.paneId = paneId;
    this.hls = null;
    this.storageKey = `fieldcam.url.${paneId}`;
    this.onLog = () => {};
    this._currentUrl = null;
    this._retryTimer = null;
    this._retryCount = 0;
    this._maxRetries = 30; // ~60s at 2s intervals
  }

  restoreLastUrl() {
    try {
      return localStorage.getItem(this.storageKey) || '';
    } catch { return ''; }
  }

  rememberUrl(url) {
    try { localStorage.setItem(this.storageKey, url); } catch {}
  }

  async load(url, { _internal = false } = {}) {
    this.destroy();
    const trimmed = (url || '').trim();
    this._currentUrl = trimmed || null;
    // Only reset the retry counter on a fresh external load; internal reloads
    // triggered by error recovery must keep counting toward the cap.
    if (!_internal) this._retryCount = 0;
    if (!trimmed) return;

    if (trimmed.startsWith('rtmp://')) {
      this.onLog('err', `Pane ${this.paneId}: RTMP cannot play in a browser. Use the Live Preview flow (MediaMTX remuxes to HLS).`);
      return;
    }

    const isHls = /\.m3u8($|\?)/i.test(trimmed);

    // Safari / iOS / some Android builds have native HLS.
    const nativeHls = this.videoEl.canPlayType('application/vnd.apple.mpegurl') !== '';

    if (isHls && typeof Hls !== 'undefined' && Hls.isSupported()) {
      // The preview flow starts the RTMP server + tells the camera to stream
      // before the MediaMTX HLS endpoint has any segments, so the first 10-30
      // seconds of manifest fetches will 404. hls.js's default retry counts
      // are too conservative for that window — bump them aggressively and
      // also handle fatal network errors by fully recreating the hls instance.
      this.hls = new Hls({
        liveDurationInfinity: true,
        lowLatencyMode: true,
        manifestLoadingMaxRetry: 20,
        manifestLoadingRetryDelay: 1500,
        manifestLoadingMaxRetryTimeout: 60000,
        levelLoadingMaxRetry: 20,
        levelLoadingRetryDelay: 1500,
        fragLoadingMaxRetry: 20,
        fragLoadingRetryDelay: 1500,
      });
      this.hls.loadSource(trimmed);
      this.hls.attachMedia(this.videoEl);
      this.hls.on(Hls.Events.ERROR, (_e, data) => {
        if (!data.fatal) return;
        // On fatal errors try to auto-recover; if we can't, destroy and
        // re-create the hls instance from scratch after a backoff. This
        // replaces the 'hit Load 3-4 times' manual recovery from the old
        // UI.
        switch (data.type) {
          case Hls.ErrorTypes.NETWORK_ERROR:
            this.onLog('warn', `Pane ${this.paneId}: HLS network error (${data.details}), retrying…`);
            try { this.hls.startLoad(); return; } catch {}
            this._scheduleReload();
            break;
          case Hls.ErrorTypes.MEDIA_ERROR:
            this.onLog('warn', `Pane ${this.paneId}: HLS media error (${data.details}), recovering…`);
            try { this.hls.recoverMediaError(); } catch { this._scheduleReload(); }
            break;
          default:
            this.onLog('err', `Pane ${this.paneId}: HLS fatal ${data.type} ${data.details} — reloading…`);
            this._scheduleReload();
            break;
        }
      });
    } else if (isHls && nativeHls) {
      this.videoEl.src = trimmed;
    } else {
      // Fall back: assume progressive / mp4 / webm.
      this.videoEl.src = trimmed;
    }

    this.rememberUrl(trimmed);
    try { await this.videoEl.play(); } catch (e) {
      this.onLog('warn', `Pane ${this.paneId}: autoplay blocked (${e.message}). Tap the video to play.`);
    }
  }

  _scheduleReload() {
    if (this._retryCount >= this._maxRetries) {
      this.onLog('err', `Pane ${this.paneId}: giving up after ${this._maxRetries} retries. Tap Stop Preview and try again.`);
      return;
    }
    this._retryCount++;
    const url = this._currentUrl;
    if (!url) return;
    if (this._retryTimer) clearTimeout(this._retryTimer);
    this._retryTimer = setTimeout(() => {
      this._retryTimer = null;
      this.onLog('warn', `Pane ${this.paneId}: reload attempt ${this._retryCount}/${this._maxRetries}`);
      this.load(url, { _internal: true });
    }, 2000);
  }

  destroy() {
    if (this._retryTimer) {
      clearTimeout(this._retryTimer);
      this._retryTimer = null;
    }
    if (this.hls) {
      try { this.hls.destroy(); } catch {}
      this.hls = null;
    }
    this.videoEl.pause();
    this.videoEl.removeAttribute('src');
    this.videoEl.load();
  }
}
