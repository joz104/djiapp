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
  }

  restoreLastUrl() {
    try {
      return localStorage.getItem(this.storageKey) || '';
    } catch { return ''; }
  }

  rememberUrl(url) {
    try { localStorage.setItem(this.storageKey, url); } catch {}
  }

  async load(url) {
    this.destroy();
    const trimmed = (url || '').trim();
    if (!trimmed) return;

    if (trimmed.startsWith('rtmp://')) {
      this.onLog('err', `Pane ${this.paneId}: RTMP cannot play in a browser. Restream as HLS (nginx-rtmp / SRS / OBS record to .m3u8) and paste the .m3u8 URL here.`);
      return;
    }

    const isHls = /\.m3u8($|\?)/i.test(trimmed);

    // Safari / iOS / some Android builds have native HLS.
    const nativeHls = this.videoEl.canPlayType('application/vnd.apple.mpegurl') !== '';

    if (isHls && typeof Hls !== 'undefined' && Hls.isSupported()) {
      this.hls = new Hls({ liveDurationInfinity: true, lowLatencyMode: true });
      this.hls.loadSource(trimmed);
      this.hls.attachMedia(this.videoEl);
      this.hls.on(Hls.Events.ERROR, (_e, data) => {
        if (data.fatal) this.onLog('err', `Pane ${this.paneId} HLS fatal: ${data.type} ${data.details}`);
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

  destroy() {
    if (this.hls) {
      try { this.hls.destroy(); } catch {}
      this.hls = null;
    }
    this.videoEl.pause();
    this.videoEl.removeAttribute('src');
    this.videoEl.load();
  }
}
