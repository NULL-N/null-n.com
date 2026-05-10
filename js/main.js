(() => {
  'use strict';

  /* ============================================
     CONFIG
     ============================================ */
  const CFG = {
    cursor: { lerp: 0.18, ringLerp: 0.1 },
    typing: {
      phrases: [
        'Art × AI × Engineering_',
        'Art × AI × Engineering_',
        'Music ©NULL-N. Not AI._',
        'Art × AI × Engineering_',
        'Art × AI × Engineering_',
        'Art × AI × Engineering_',
        'If you remember the name, I\'ve already won._',
      ],
      speed: 60,
      pause: 2000,
      deleteSpeed: 30,
    },
  };

  /* ============================================
     UTILS
     ============================================ */
  const lerp = (a, b, t) => a + (b - a) * t;
  const isTouchDevice = () => matchMedia('(hover: none)').matches;

  /* ============================================
     STEMS — site-wide DNA. Same 5 stems power both A (held at 1.0 = original
     mix) and B (cursor blends them). The shared AudioContext means audio
     never breaks during scene transitions.
     ============================================ */
  const STEMS = [
    { id: 'main-gt',   file: '/api/audio/Main Gt.flac',    pos: [0.50, 0.13] },  // 北 (melody)
    { id: 'synth-gt',  file: '/api/audio/Synth Gt.flac',   pos: [0.78, 0.25] },  // 右上
    { id: 'synth-pad', file: '/api/audio/Synth PAD.flac',  pos: [0.88, 0.50] },  // 右
    { id: 'drums',     file: '/api/audio/Dr.flac',         pos: [0.50, 0.87] },  // 真南
    { id: 'bass',      file: '/api/audio/Bass.flac',       pos: [0.12, 0.50] },  // 左
  ];

  // Pairs with the same key in functions/api/audio/[file].js — bytes coming
  // out of /api/audio are AES-GCM ciphertext (12-byte IV prepended). Network-tab
  // capture yields gibberish without this key.
  const STREAM_KEY_B64 = 'k7Vs1GXZCawdoMaYFDtGCH/umDLu/VF1Qm5IKIJPQqY=';
  let _streamKey = null;
  async function _getStreamKey() {
    if (_streamKey) return _streamKey;
    const raw = Uint8Array.from(atob(STREAM_KEY_B64), c => c.charCodeAt(0));
    _streamKey = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
    return _streamKey;
  }
  async function fetchStream(url) {
    const res = await fetch(encodeURI(url));
    if (!res.ok) throw new Error('fetch failed: ' + url);
    const buf = new Uint8Array(await res.arrayBuffer());
    const iv = buf.subarray(0, 12);
    const cipher = buf.subarray(12);
    const key = await _getStreamKey();
    return await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher);
  }

  /* ============================================
     PARTICLE WORKER — OffscreenCanvas
     Three.js runs entirely off the main thread.
     ============================================ */
  class ParticleWorker {
    constructor(canvas) {
      this.mouseX = 0;
      this.mouseY = 0;
      this.scrollY = 0;
      this.dirty = 0; // bitmask: 1=mouse, 2=scroll
      this.canvasEl = canvas;

      const dpr = Math.min(window.devicePixelRatio, 2);
      const isMobile = window.innerWidth < 768;
      const { width, height } = this._size();
      const offscreen = canvas.transferControlToOffscreen();

      this.worker = new Worker('js/particles-worker.js');
      this.worker.postMessage({
        type: 'init',
        canvas: offscreen,
        width,
        height,
        dpr: isMobile ? Math.min(dpr, 1) : dpr,
        particleCount: isMobile ? 800 : 2000,
      }, [offscreen]);

      this.bindEvents();
      this.sendLoop();
    }

    _size() {
      const r = this.canvasEl.getBoundingClientRect();
      return { width: Math.max(1, Math.round(r.width)), height: Math.max(1, Math.round(r.height)) };
    }

    bindEvents() {
      window.addEventListener('mousemove', e => {
        this.mouseX = (e.clientX / window.innerWidth) * 2 - 1;
        this.mouseY = -(e.clientY / window.innerHeight) * 2 + 1;
        this.dirty |= 1;
      }, { passive: true });

      window.addEventListener('scroll', () => {
        this.scrollY = window.scrollY;
        this.dirty |= 2;
      }, { passive: true });

      document.addEventListener('visibilitychange', () => {
        this.worker.postMessage({ type: 'visibility', visible: !document.hidden });
      });

      let resizeTimer;
      const onResize = () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
          const dpr = window.innerWidth < 768 ? Math.min(window.devicePixelRatio, 1) : Math.min(window.devicePixelRatio, 2);
          const { width, height } = this._size();
          this.worker.postMessage({ type: 'resize', width, height, dpr });
        }, 150);
      };
      window.addEventListener('resize', onResize);
      window.addEventListener('orientationchange', onResize);
      if (window.visualViewport) window.visualViewport.addEventListener('resize', onResize);
    }

    sendLoop() {
      if (this.dirty & 1) {
        this.worker.postMessage({ type: 'mouse', x: this.mouseX, y: this.mouseY });
      }
      if (this.dirty & 2) {
        this.worker.postMessage({ type: 'scroll', y: this.scrollY });
      }
      this.dirty = 0;
      requestAnimationFrame(() => this.sendLoop());
    }
  }

  /* ============================================
     SHADER FALLBACK — CSS gradient
     For browsers without OffscreenCanvas.
     ============================================ */
  class ShaderFallback {
    constructor(canvas) {
      canvas.style.display = 'none';
      document.body.style.background = [
        'radial-gradient(ellipse at 30% 40%, rgba(0,255,170,0.07) 0%, transparent 50%)',
        'radial-gradient(ellipse at 70% 60%, rgba(123,97,255,0.06) 0%, transparent 50%)',
        'radial-gradient(ellipse at 50% 80%, rgba(255,51,102,0.04) 0%, transparent 60%)',
        '#0a0a0f',
      ].join(',');
    }
  }

  /* ============================================
     CUSTOM CURSOR — GPU-composited via translate3d
     ============================================ */
  class CustomCursor {
    constructor() {
      if (isTouchDevice()) return;
      this.dot  = document.querySelector('.cursor-dot');
      this.ring = document.querySelector('.cursor-ring');
      this.pos  = { x: 0, y: 0 };
      this.target = { x: 0, y: 0 };
      this.ringPos = { x: 0, y: 0 };
      this.visible = false;
      this.moving = false;
      this.bindEvents();
      this.loop();
    }
    bindEvents() {
      document.addEventListener('mousemove', e => {
        this.target.x = e.clientX;
        this.target.y = e.clientY;
        this.moving = true;
        if (!this.visible) {
          this.visible = true;
          this.pos.x = this.ringPos.x = e.clientX;
          this.pos.y = this.ringPos.y = e.clientY;
        }
      }, { passive: true });
      const sel = 'a, button, [data-magnetic]';
      document.addEventListener('mouseover', e => {
        if (e.target.closest(sel)) { this.dot.classList.add('hovering'); this.ring.classList.add('hovering'); }
      });
      document.addEventListener('mouseout', e => {
        if (e.target.closest(sel)) { this.dot.classList.remove('hovering'); this.ring.classList.remove('hovering'); }
      });
    }
    loop() {
      if (this.moving) {
        this.pos.x  = lerp(this.pos.x,  this.target.x, CFG.cursor.lerp);
        this.pos.y  = lerp(this.pos.y,  this.target.y, CFG.cursor.lerp);
        this.ringPos.x = lerp(this.ringPos.x, this.target.x, CFG.cursor.ringLerp);
        this.ringPos.y = lerp(this.ringPos.y, this.target.y, CFG.cursor.ringLerp);
        this.dot.style.transform  = `translate3d(${this.pos.x}px,${this.pos.y}px,0) translate(-50%,-50%)`;
        this.ring.style.transform = `translate3d(${this.ringPos.x}px,${this.ringPos.y}px,0) translate(-50%,-50%)`;
        if (Math.abs(this.pos.x - this.target.x) < 0.1 && Math.abs(this.pos.y - this.target.y) < 0.1) {
          this.moving = false;
        }
      }
      requestAnimationFrame(() => this.loop());
    }
  }

  /* ============================================
     TYPING EFFECT
     ============================================ */
  class TypingEffect {
    constructor(el) {
      this.el = el;
      this.phrases = CFG.typing.phrases;
      this.index = 0;
      this.charIndex = 0;
      this.deleting = false;
      this.stopped = false;
      this._timer = null;
      this.loop();
    }
    stop() {
      this.stopped = true;
      if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    }
    _schedule(ms) {
      if (this.stopped) return;
      this._timer = setTimeout(() => this.loop(), ms);
    }
    loop() {
      if (this.stopped) return;
      const phrase = this.phrases[this.index];
      if (!this.deleting) {
        this.el.textContent = phrase.substring(0, ++this.charIndex);
        if (this.charIndex === phrase.length) { this.deleting = true; this._schedule(CFG.typing.pause); return; }
        this._schedule(CFG.typing.speed);
      } else {
        this.el.textContent = phrase.substring(0, --this.charIndex);
        if (this.charIndex === 0) { this.deleting = false; this.index = (this.index + 1) % this.phrases.length; this._schedule(400); return; }
        this._schedule(CFG.typing.deleteSpeed);
      }
    }
  }


  /* ============================================
     WAVEFORM VISUALIZER — idle breathing + live audio
     ============================================ */
  class WaveformVisualizer {
    constructor(canvas) {
      this.canvas = canvas;
      this.c = canvas.getContext('2d');
      this.analyser = null;
      this.waveData = null;
      this.playing = false;
      this.time = 0;
      this.hover = false;
      this.rafId = null;

      const dpr = Math.min(window.devicePixelRatio, 2);
      const rect = canvas.getBoundingClientRect();
      this.w = rect.width;
      this.h = rect.height;
      canvas.width  = this.w * dpr;
      canvas.height = this.h * dpr;
      this.c.scale(dpr, dpr);

      // Active-waveform color cycle (dark scene only). Bright pulses with
      // white spikes — bass-paced cycling. Light scene uses its own
      // hardcoded slow 4-color cycle inside _color().
      this.colors = [
        [80,140,255],
        [255,255,255],
        [255,200,60],
        [255,50,80],
        [255,255,255],
        [0,255,170],
      ];
      this.beatPhase = 0;

      // Bright orbs glow nicely with screen-blend on the dark Scene A.
      // Light Scene B uses an entirely different idle language (3 ink dots,
      // see _idleLight) so it doesn't need an alternate orb palette.
      this.orbs = [
        { col: [0,255,170],   fx: 0.7,  fy: 0.9,  px: 0,   py: 0.5, sz: 0.3  },
        { col: [80,140,255],  fx: -0.5, fy: 0.8,  px: 1.5, py: 0,   sz: 0.28 },
        { col: [255,200,60],  fx: 0.9,  fy: -0.6, px: 3.0, py: 2.0, sz: 0.26 },
        { col: [255,100,180], fx: -0.6, fy: 0.7,  px: 4.5, py: 1.0, sz: 0.27 },
      ];
      this.theme = 'dark';

      canvas.parentElement.addEventListener('mouseenter', () => { this.hover = true; });
      canvas.parentElement.addEventListener('mouseleave', () => { this.hover = false; });

      this._idle();
    }

    setTheme(t) {
      this.theme = t === 'light' ? 'light' : 'dark';
      // Only the idle language switches (orb cloud ↔ 3 ink dots).
      // Active stroke palette is governed inside _color()/_active.
    }

    setAnalyser(analyser) {
      this.analyser = analyser;
      this.waveData = new Uint8Array(analyser.fftSize);
    }

    _color(phase) {
      // Light theme: refined slate silver — visible on white without the
      // weight of pure black, with a slight cool undertone for "品" feel.
      if (this.theme === 'light') return [160, 168, 188];

      const len = this.colors.length;
      const p = ((phase) % len + len) % len;
      const ci = Math.floor(p);
      const cf = p - ci;
      const from = this.colors[ci];
      const to = this.colors[(ci + 1) % this.colors.length];
      return [
        Math.round(from[0] + (to[0] - from[0]) * cf),
        Math.round(from[1] + (to[1] - from[1]) * cf),
        Math.round(from[2] + (to[2] - from[2]) * cf),
      ];
    }

    setPlaying(v) {
      const was = this.playing;
      this.playing = v;
      if (this.rafId) { cancelAnimationFrame(this.rafId); this.rafId = null; }
      if (v && !was) this._active();
      if (!v && was) this._idle();
    }

    _idle() {
      if (this.playing) return;
      this.time += 0.016;
      const { c, w, h, time: t } = this;
      c.clearRect(0, 0, w, h);

      if (this.theme === 'light') this._idleLight(c, w, h, t);
      else this._idleDark(c, w, h, t);

      this.rafId = requestAnimationFrame(() => this._idle());
    }

    _idleDark(c, w, h, t) {
      const cx = w / 2, cy = h / 2;
      const s = Math.min(w, h);
      const alpha = this.hover ? 0.45 : 0.3;
      c.globalCompositeOperation = 'screen';
      for (const o of this.orbs) {
        const drift = s * 0.13;
        const ox = cx + Math.sin(t * o.fx + o.px) * drift;
        const oy = cy + Math.cos(t * o.fy + o.py) * drift;
        const r = s * o.sz + Math.sin(t * o.fx * 1.3) * s * 0.03;
        const [cr, cg, cb] = o.col;
        const g = c.createRadialGradient(ox, oy, 0, ox, oy, r);
        g.addColorStop(0,    `rgba(${cr},${cg},${cb},${alpha})`);
        g.addColorStop(0.35, `rgba(${cr},${cg},${cb},${alpha * 0.4})`);
        g.addColorStop(1,    `rgba(${cr},${cg},${cb},0)`);
        c.fillStyle = g;
        c.beginPath();
        c.arc(ox, oy, r, 0, Math.PI * 2);
        c.fill();
      }
      c.globalCompositeOperation = 'source-over';
    }

    _idleLight(c, w, h, t) {
      // Orb clouds inevitably mud on white (semi-transparent overlap →
      // mid-tones). Switch the language entirely: 3 ink dots breathing
      // out of phase. Crisp, formal, reads as "audio standby".
      const cx = w / 2, cy = h / 2;
      const s = Math.min(w, h);
      const baseR = s * 0.045;
      const gap = s * 0.14;
      const hoverBoost = this.hover ? 0.15 : 0;
      for (let i = 0; i < 3; i++) {
        const phase = t * 1.4 + (i - 1) * (Math.PI * 2 / 3);
        const breath = (Math.sin(phase) + 1) / 2;
        const r = baseR * (0.55 + breath * 0.65);
        const a = 0.22 + breath * 0.4 + hoverBoost;
        c.fillStyle = `rgba(10,10,15,${a.toFixed(3)})`;
        c.beginPath();
        c.arc(cx + (i - 1) * gap, cy, r, 0, Math.PI * 2);
        c.fill();
      }
    }

    setBass(v) { this.beatPhase += v * 0.06; }

    _active() {
      if (!this.playing || !this.analyser) { this._idle(); return; }
      this.time += 0.016;
      this.analyser.getByteTimeDomainData(this.waveData);

      const { c, w, h, waveData } = this;
      c.clearRect(0, 0, w, h);

      const cx = w / 2, cy = h / 2;
      const base = Math.min(w, h) * 0.25;
      // Mobile audio button is smaller (76 / 56 px); narrow the wave's
      // excursion so it stays legible inside the smaller circle.
      const amp = w < 80 ? 0.38 : 0.55;
      const pts = 128;
      const [cr, cg, cb] = this._color(this.beatPhase);

      // Light theme: silver core line + a different hue as a delicate halo
      // (warm champagne) gives the ring a subtle two-tone luminance —
      // "axis color + something refined whispering around it".
      // Dark theme keeps the original same-hue glow.
      const isLight = this.theme === 'light';
      const strokeAlpha = 1.0;
      const shadowAlpha = isLight ? 0.22 : 1.0;
      const blur        = isLight ? 6    : 12;
      const haloR = isLight ? 218 : cr;
      const haloG = isLight ? 195 : cg;
      const haloB = isLight ? 150 : cb;

      c.save();
      c.shadowColor = `rgba(${haloR},${haloG},${haloB},${shadowAlpha})`;
      c.shadowBlur = blur;
      c.beginPath();
      c.strokeStyle = `rgba(${cr},${cg},${cb},${strokeAlpha})`;
      c.lineWidth = 1.5;

      for (let i = 0; i <= pts; i++) {
        const a = (i / pts) * Math.PI * 2 - Math.PI / 2;
        const di = Math.floor((i / pts) * waveData.length);
        const v = (waveData[di] - 128) / 128;
        const r = base + v * base * amp;
        const x = cx + Math.cos(a) * r;
        const y = cy + Math.sin(a) * r;
        i === 0 ? c.moveTo(x, y) : c.lineTo(x, y);
      }
      c.closePath();
      c.stroke();
      c.restore();

      this.rafId = requestAnimationFrame(() => this._active());
    }
  }

  /* ============================================
     AUDIO PLAYER — Web Audio API + Media Session
     5-stem playback. Each stem has its own gain so a scene-level mixer
     (Scene B) can sculpt them in real time. Default = all stems at 1.0
     (= the song as composed). The same AudioContext spans every scene,
     so transitions A→B→A never break the music.
     ============================================ */
  class AudioPlayer {
    constructor(worker) {
      this.worker = worker;
      this.btn = document.getElementById('audio-btn');
      this.ctx = null;
      this.analyser = null;
      this.master = null;
      this.freqData = null;
      this.playing = false;
      this.bass = 0;
      this.mid = 0;
      this.high = 0;
      this.subscribers = new Set();
      this.waveform = new WaveformVisualizer(document.getElementById('audio-wave'));

      // Stem state
      this._stemArrayBuffers = new Map(); // id -> ArrayBuffer (pre-fetched)
      this.stemBuffers       = new Map(); // id -> AudioBuffer (decoded on first play)
      this.stemSources       = new Map(); // id -> AudioBufferSourceNode (created at play)
      this.stemGains         = new Map(); // id -> GainNode (per-stem volume)

      // SE (one-shot sound effects) — mixed alongside stems but never routed
      // through the analyser so SE doesn't influence the BGM visualizer.
      this._sePending = new Map();
      this.seBuffers  = new Map();

      this.btn.addEventListener('click', () => this.toggle());

      // Pre-fetch all 5 stem files in parallel (no decoding until ctx exists).
      this.readyPromise = this._fetchStems();
    }

    /**
     * Subscribe to per-frame audio data.
     * @param {(data: {bass:number, mid:number, high:number}) => void} fn
     * @returns {() => void} unsubscribe
     */
    subscribe(fn) {
      this.subscribers.add(fn);
      // Push the latest snapshot immediately so newly-mounted scenes
      // don't wait a frame for state.
      try { fn({ bass: this.bass, mid: this.mid, high: this.high }); } catch (_) {}
      return () => this.subscribers.delete(fn);
    }

    _emit(bass, mid, high) {
      const data = { bass, mid, high };
      for (const fn of this.subscribers) {
        try { fn(data); } catch (_) {}
      }
    }

    /**
     * Pre-fetch (and decode, if AudioContext is available) a SE buffer.
     * Idempotent — repeated calls with the same name are no-ops.
     */
    preloadSE(name, url) {
      if (this.seBuffers.has(name) || this._sePending.has(name)) return;
      const arrPromise = fetch(url)
        .then(r => r.ok ? r.arrayBuffer() : null)
        .catch(() => null);
      this._sePending.set(name, arrPromise);
      if (this.ctx) this._decodeSE(name);
    }

    async _decodeSE(name) {
      if (!this.ctx) return;
      const arrPromise = this._sePending.get(name);
      if (!arrPromise) return;
      this._sePending.delete(name);
      const arr = await arrPromise;
      if (!arr) return;
      try {
        const buf = await this.ctx.decodeAudioData(arr);
        this.seBuffers.set(name, buf);
      } catch (e) {
        console.warn('SE decode failed', name, e);
      }
    }

    async _decodePendingSEs() {
      if (!this.ctx) return;
      for (const name of Array.from(this._sePending.keys())) {
        await this._decodeSE(name);
      }
    }

    /**
     * Play a one-shot SE. Requires the BGM ctx to be running (BGM was
     * tapped at least once). Mixes alongside BGM at `volume`, never
     * routed through the analyser so it doesn't influence visuals.
     */
    playSE(name, { volume = 0.45 } = {}) {
      if (!this.ctx || this.ctx.state !== 'running') return;
      const buf = this.seBuffers.get(name);
      if (!buf) return;
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      const gain = this.ctx.createGain();
      gain.gain.value = volume;
      src.connect(gain);
      gain.connect(this.ctx.destination);
      src.start(0);
    }

    async _fetchStems() {
      try {
        await Promise.all(STEMS.map(async (s) => {
          const ab = await fetchStream(s.file);
          this._stemArrayBuffers.set(s.id, ab);
        }));
      } catch (e) {
        console.warn('Stem fetch failed', e);
      }
    }

    async play() {
      if (this.playing) return;
      this.playing = true;
      try {
        // --- sync portion (preserves user gesture) ---
        if (!this.ctx) {
          const Ctx = window.AudioContext || window.webkitAudioContext;
          if (!Ctx) { this.playing = false; return; }
          this.ctx = new Ctx();
          this.analyser = this.ctx.createAnalyser();
          this.analyser.fftSize = 256;
          this.analyser.smoothingTimeConstant = 0.8;
          this.master = this.ctx.createGain();
          this.master.gain.value = 1.0;
          this.master.connect(this.analyser);
          this.analyser.connect(this.ctx.destination);
          this.freqData = new Uint8Array(this.analyser.frequencyBinCount);
          this.waveform.setAnalyser(this.analyser);

          if ('mediaSession' in navigator) {
            navigator.mediaSession.metadata = new MediaMetadata({
              title: '17 — No AI. Just Music.',
              artist: 'NULL-N',
            });
            navigator.mediaSession.setActionHandler('play', () => this.play());
            navigator.mediaSession.setActionHandler('pause', () => this.pause());
          }
        }
        const resumePromise = this.ctx.state === 'suspended' ? this.ctx.resume() : Promise.resolve();

        // --- async portion ---
        await resumePromise;

        // Decode all stems on first play (after user gesture)
        if (this.stemBuffers.size === 0) {
          if (this._stemArrayBuffers.size === 0) await this.readyPromise;
          if (this._stemArrayBuffers.size === 0) { this.playing = false; return; }
          await Promise.all(STEMS.map(async (s) => {
            const ab = this._stemArrayBuffers.get(s.id);
            if (!ab) return;
            try {
              const buf = await this.ctx.decodeAudioData(ab);
              this.stemBuffers.set(s.id, buf);
            } catch (e) {
              console.warn('Stem decode failed', s.id, e);
            }
          }));
          this._stemArrayBuffers.clear();
        }

        // Schedule all sources to start at the same ctx time = sample-accurate sync
        if (this.stemSources.size === 0) {
          const startAt = this.ctx.currentTime + 0.1;
          for (const s of STEMS) {
            const buf = this.stemBuffers.get(s.id);
            if (!buf) continue;
            const src = this.ctx.createBufferSource();
            src.buffer = buf;
            src.loop = true;
            const gain = this.ctx.createGain();
            gain.gain.value = 1.0; // default = full original mix
            src.connect(gain).connect(this.master);
            src.start(startAt);
            this.stemSources.set(s.id, src);
            this.stemGains.set(s.id, gain);
          }
        }

        this._decodePendingSEs();

        this.btn.classList.add('playing', 'visible');
        this.waveform.setPlaying(true);
        if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
        this._loop();
      } catch (e) {
        this.playing = false;
        console.warn('Audio play failed', e);
      }
    }

    /**
     * Smoothly target a single stem's gain. Used by Scene B's mixer.
     * Audio thread interpolates with a small time-constant for click-free changes.
     */
    setStemGain(id, value, timeConstant = 0.06) {
      const g = this.stemGains.get(id);
      if (!g || !this.ctx) return;
      g.gain.setTargetAtTime(value, this.ctx.currentTime, timeConstant);
    }

    /** Bulk-set per-frame stem weights (preferred for cursor-driven mixing). */
    setStemWeights(weights, timeConstant = 0.06) {
      if (!this.ctx) return;
      const now = this.ctx.currentTime;
      for (const id in weights) {
        const g = this.stemGains.get(id);
        if (g) g.gain.setTargetAtTime(weights[id], now, timeConstant);
      }
    }

    /** Smoothly return all stems to 1.0 (= the song as composed). */
    resetStemsToFull(timeConstant = 0.4) {
      if (!this.ctx) return;
      const now = this.ctx.currentTime;
      for (const g of this.stemGains.values()) {
        g.gain.setTargetAtTime(1.0, now, timeConstant);
      }
    }

    /** Freeze all stems at their *current* gain value, cancelling any
     * scheduled targets. Used by Scene B's lock so the held mix is exactly
     * what visitor heard at the moment of click — no smoothing residue. */
    snapshotStems() {
      if (!this.ctx) return;
      const now = this.ctx.currentTime;
      for (const g of this.stemGains.values()) {
        const v = g.gain.value;
        g.gain.cancelScheduledValues(now);
        g.gain.setValueAtTime(v, now);
      }
    }

    async pause() {
      if (!this.playing) return;
      this.playing = false;
      if (this.ctx && this.ctx.state === 'running') {
        try { await this.ctx.suspend(); } catch (_) {}
      }
      this.btn.classList.remove('playing');
      this.waveform.setPlaying(false);
      this.bass = this.mid = this.high = 0;
      if (this.worker) {
        this.worker.postMessage({ type: 'audio', bass: 0, mid: 0, high: 0 });
      }
      this._emit(0, 0, 0);
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
    }

    toggle() {
      this.playing ? this.pause() : this.play();
    }

    _loop() {
      if (!this.playing) return;
      this.analyser.getByteFrequencyData(this.freqData);
      const len = this.freqData.length;

      let b = 0;
      for (let i = 0; i < 8; i++) b += this.freqData[i];
      b = (b / 8) / 255;

      let m = 0;
      for (let i = 8; i < 48; i++) m += this.freqData[i];
      m = (m / 40) / 255;

      let h = 0;
      for (let i = 48; i < len; i++) h += this.freqData[i];
      h = (h / (len - 48)) / 255;

      this.bass = lerp(this.bass, b, 0.15);
      this.mid  = lerp(this.mid,  m, 0.2);
      this.high = lerp(this.high, h, 0.25);

      if (this.worker) {
        this.worker.postMessage({
          type: 'audio',
          bass: this.bass,
          mid: this.mid,
          high: this.high,
        });
      }

      this.waveform.setBass(this.bass);

      // Fan out to scene-level subscribers (hero glow, B pulse, etc.)
      this._emit(this.bass, this.mid, this.high);

      requestAnimationFrame(() => this._loop());
    }
  }

  /* ============================================
     MAGNETIC BUTTONS
     ============================================ */
  class MagneticButtons {
    constructor() {
      if (isTouchDevice()) return;
      document.querySelectorAll('[data-magnetic]').forEach(el => {
        el.addEventListener('mousemove', e => {
          const r = el.getBoundingClientRect();
          el.style.transform = `translate3d(${(e.clientX - r.left - r.width / 2) * 0.25}px,${(e.clientY - r.top - r.height / 2) * 0.25}px,0)`;
        });
        el.addEventListener('mouseleave', () => {
          el.style.transform = '';
          el.style.transition = 'transform 0.4s cubic-bezier(0.16,1,0.3,1)';
          setTimeout(() => { el.style.transition = ''; }, 400);
        });
      });
    }
  }

  /* ============================================
     SCENE MANAGER — owns transitions, URL state, history.
     AudioPlayer is *not* recreated across scenes, so BGM never breaks.
     ============================================ */
  class SceneManager {
    constructor({ audioPlayer }) {
      this.audioPlayer = audioPlayer;
      this.scenes = new Map(); // id -> factory(ctx) => { mount, unmount }
      this.current = null;
      this.reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
    }

    register(id, factory) { this.scenes.set(id, factory); }

    async show(id, { skipUrl = false } = {}) {
      if (this.current?.id === id) return;
      const factory = this.scenes.get(id);
      if (!factory) return;

      const next = factory({ audioPlayer: this.audioPlayer, manager: this });
      const isFirstMount = !this.current;

      const swap = () => {
        this.current?.instance.unmount();
        next.mount();
        document.body.dataset.scene = id;
        this._syncToggle(id);
      };

      // Skip view-transition on first mount (no "before" state to morph from).
      const useTransition =
        !isFirstMount &&
        typeof document.startViewTransition === 'function' &&
        !this.reducedMotion;

      if (useTransition) {
        try {
          await document.startViewTransition(swap).finished;
        } catch (_) { /* user cancelled / browser hiccup — already swapped */ }
      } else {
        swap();
      }

      this.current = { id, instance: next };

      if (!skipUrl) {
        const url = new URL(window.location);
        if (id === 'a') url.searchParams.delete('scene');
        else url.searchParams.set('scene', id);
        history.pushState({ scene: id }, '', url);
      }
    }

    _syncToggle(id) {
      document.querySelectorAll('[data-scene-target]').forEach(b => {
        b.setAttribute('aria-pressed', String(b.dataset.sceneTarget === id));
      });
    }

    bind() {
      document.querySelectorAll('[data-scene-target]').forEach(b => {
        b.addEventListener('click', () => this.show(b.dataset.sceneTarget));
      });
      window.addEventListener('popstate', e => {
        const id = e.state?.scene
          ?? new URLSearchParams(location.search).get('scene')
          ?? 'a';
        this.show(id, { skipUrl: true });
      });
    }
  }

  /* ============================================
     SCENE A — single page. Hero + typing as the first impression, then
     after the visitor's first click the playground constellation reveals
     itself: 5 stars fade in, cursor begins sculpting the stem mix, click
     toggles a lock with a green decision-star marker.

     The audio never breaks: stems play at gain 1.0 (= original mix) until
     playground engages, after which cursor influences blend in real time.
     ============================================ */
  function createSceneA({ audioPlayer, manager }) {
    const SIGMA = 0.32;
    const SMOOTH = 0.06;
    // "Full mix" is governed by distance to the NEAREST star, not the screen
    // centre. Anywhere far from any star → original mix; near a star → that
    // stem isolates. This means the audio-button corner, the screen centre,
    // and any "negative space" between stars all play the song as composed.
    const STAR_NEAR = 0.10;   // within: pure Gaussian / isolation
    const STAR_FAR  = 0.28;   // beyond: full mix
    const PLAYGROUND_REVEAL_DELAY = 1500;

    const root = document.getElementById('scene-a');
    const heroTitle = root.querySelector('.hero-title');
    let unsubscribe = null;
    let typing = null;
    let lastGlow = -1;
    let mountedOnce = false;

    // Playground requires a precise pointer (mouse / trackpad). On phones &
    // tablets-without-mouse the cursor metaphor breaks (finger covers the
    // very point being aimed at), so the playground is gated to desktop.
    const hasFinePointer = matchMedia('(hover: hover) and (pointer: fine)').matches;

    let mouseListener = null;
    let clickListener = null;
    let playgroundOn = false;
    let playgroundScheduled = false;
    let locked = false;
    let dirty = false;
    let rafId = null;
    let cursorPx = window.innerWidth / 2;
    let cursorPy = window.innerHeight / 2;
    let cursorX = 0.5, cursorY = 0.5;

    function smoothstep(a, b, x) {
      const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
      return t * t * (3 - 2 * t);
    }

    function placeStemElements() {
      for (const s of STEMS) {
        const node = root.querySelector('#node-' + s.id);
        if (node) {
          node.style.left = (s.pos[0] * 100) + 'vw';
          node.style.top  = (s.pos[1] * 100) + 'vh';
        }
      }
    }

    function updateMix() {
      // First pass: find squared distance to every star + the smallest one.
      let minD2 = Infinity;
      const dist2 = {};
      for (const s of STEMS) {
        const dx = cursorX - s.pos[0];
        const dy = cursorY - s.pos[1];
        const d2 = dx * dx + dy * dy;
        dist2[s.id] = d2;
        if (d2 < minD2) minD2 = d2;
      }
      const minD = Math.sqrt(minD2);

      // Far from any star → fullW = 1 (original mix). Near a star → fullW = 0
      // (that stem isolates).  Screen corners, between-star gaps, and the
      // audio-button area all sit in fullW = 1 territory.
      const fullW = smoothstep(STAR_NEAR, STAR_FAR, minD);

      const audioWeights = {};
      const visualWeights = {};
      for (const s of STEMS) {
        const gauss = Math.exp(-dist2[s.id] / (2 * SIGMA * SIGMA));
        audioWeights[s.id]  = fullW + (1 - fullW) * gauss;
        visualWeights[s.id] = gauss;
      }

      if (playgroundOn && !locked) audioPlayer.setStemWeights(audioWeights, SMOOTH);

      for (const s of STEMS) {
        const node = root.querySelector('#node-' + s.id);
        if (node) {
          node.style.setProperty('--w', visualWeights[s.id].toFixed(3));
          node.style.setProperty('--a', audioWeights[s.id].toFixed(3));
        }
      }
    }

    function flush() {
      rafId = null;
      if (!dirty) return;
      dirty = false;
      const ch = root.querySelector('.b-crosshair');
      if (ch) ch.style.transform = `translate(${cursorPx}px, ${cursorPy}px)`;
      updateMix();
    }

    function flashStars() {
      // A subtle "we're here" hint — each star briefly brightens with a
      // 130ms stagger so a wave of light passes through the constellation.
      STEMS.forEach((s, i) => {
        const node = root.querySelector('#node-' + s.id);
        if (!node) return;
        setTimeout(() => {
          node.style.transition = 'filter 0.22s ease, box-shadow 0.22s ease';
          node.style.filter = 'brightness(2.6)';
          node.style.boxShadow = '0 0 8px currentColor, 0 0 30px currentColor, 0 0 80px currentColor';
          setTimeout(() => {
            node.style.filter = '';
            node.style.boxShadow = '';
            // Drop the transition next tick so the perpetual twinkle/halo
            // resumes from the CSS calc without a lingering interpolation.
            setTimeout(() => { node.style.transition = ''; }, 220);
          }, 220);
        }, i * 130);
      });
    }

    function activatePlayground() {
      if (playgroundOn || !hasFinePointer) return;
      playgroundOn = true;
      document.body.classList.add('playground-on');
      updateMix();
      // Hint flash 7s after the constellation appears — long enough that
      // the visitor has time to look, short enough that they haven't given up.
      setTimeout(flashStars, 7000);
    }

    function schedulePlayground() {
      if (playgroundScheduled || playgroundOn || !hasFinePointer) return;
      playgroundScheduled = true;
      setTimeout(activatePlayground, PLAYGROUND_REVEAL_DELAY);
    }

    return {
      mount() {
        root.classList.add('active');
        audioPlayer.waveform.setTheme('dark');

        if (!mountedOnce) {
          mountedOnce = true;
          gsap.timeline()
            .to('.hero-title',  { opacity: 1, y: 0, duration: 1.2, ease: 'expo.out' })
            .to('.hero-prompt', { opacity: 1, y: 0, duration: 0.8, ease: 'expo.out' }, '-=0.6');
        } else {
          gsap.set('.hero-title',  { opacity: 1, y: 0 });
          gsap.set('.hero-prompt', { opacity: 1, y: 0 });
        }

        typing = new TypingEffect(document.getElementById('typed-text'));

        unsubscribe = audioPlayer.subscribe(({ bass }) => {
          // Auto-reveal the playground once audio is up — covers both the
          // "click body to start" and "click audio button to start" paths.
          if (audioPlayer.playing) schedulePlayground();

          const g = (bass * 0.7 * 100 | 0) / 100;
          if (g === lastGlow) return;
          lastGlow = g;
          heroTitle.style.textShadow = g > 0.01
            ? `0 0 ${20 + g * 50}px rgba(0,255,170,${g * 0.35}), 0 0 ${60 + g * 80}px rgba(0,255,170,${g * 0.12})`
            : '';
        });

        // Mobile / touch-only devices: skip all playground bindings entirely.
        // Visitor still gets the hero, BGM, cosmic shader, audio button.
        if (!hasFinePointer) return;

        placeStemElements();

        // Cursor tracking from first frame so the crosshair already follows
        // the visitor before they ever click. Visuals only "bloom" once
        // the playground turns on.
        mouseListener = (e) => {
          cursorPx = e.clientX;
          cursorPy = e.clientY;
          cursorX = e.clientX / window.innerWidth;
          cursorY = e.clientY / window.innerHeight;
          dirty = true;
          if (rafId === null) rafId = requestAnimationFrame(flush);
        };
        document.addEventListener('mousemove', mouseListener, { passive: true });

        clickListener = (e) => {
          // Persistent UI (audio btn, github link, etc.) keeps its own behaviour.
          if (e.target.closest('a, button, [data-no-scene-tap]')) return;

          // Audio is started ONLY via the bottom-right audio button. Body
          // clicks are inert until the playground has come alive (i.e. after
          // the visitor explicitly engaged with the music).
          if (!playgroundOn) return;

          // Once playground is on, body clicks toggle the mix lock and drop
          // a green decision-star at the cursor position.
          locked = !locked;
          document.body.classList.toggle('locked', locked);
          if (locked) {
            audioPlayer.snapshotStems();
            const marker = root.querySelector('.b-lock-marker');
            if (marker) marker.style.transform = `translate(${cursorPx}px, ${cursorPy}px)`;
          }
        };
        // Bind on document so clicks on the cosmic shader (which sits outside
        // #scene-a as a fixed background) also reach the handler.
        document.addEventListener('click', clickListener);
      },
      unmount() {
        root.classList.remove('active');
        heroTitle.style.textShadow = '';
        lastGlow = -1;
        unsubscribe?.(); unsubscribe = null;
        typing?.stop?.(); typing = null;
        if (mouseListener) document.removeEventListener('mousemove', mouseListener);
        if (clickListener) document.removeEventListener('click', clickListener);
        mouseListener = clickListener = null;
        if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
        locked = false;
        playgroundOn = false;
        playgroundScheduled = false;
        document.body.classList.remove('locked', 'playground-on');
      }
    };
  }

  /* ============================================
     APP
     ============================================ */
  class App {
    constructor() {
      this.cursor = new CustomCursor();

      // OffscreenCanvas → Worker, fallback → main thread (reduced)
      const canvas = document.getElementById('bg-canvas');
      try {
        if (canvas.transferControlToOffscreen) {
          this.particles = new ParticleWorker(canvas);
        } else {
          this.particles = new ShaderFallback(canvas);
        }
      } catch (e) {
        this.particles = new ShaderFallback(canvas);
      }
    }

    async init() {
      await document.fonts.ready;

      // Audio — singleton, persists across scenes.
      const worker = this.particles instanceof ParticleWorker ? this.particles.worker : null;
      this.audioPlayer = new AudioPlayer(worker);
      this.audioPlayer.btn.classList.add('visible');

      new MagneticButtons();

      this.scenes = new SceneManager({ audioPlayer: this.audioPlayer });
      this.scenes.register('a', createSceneA);
      this.scenes.bind();
      this.scenes.show('a', { skipUrl: true });
    }
  }

  /* ============================================
     BOOT
     ============================================ */
  document.addEventListener('DOMContentLoaded', () => new App().init());
})();
