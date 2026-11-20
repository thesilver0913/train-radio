// 音声エンジン: マイク取り込み(AudioWorklet) → 帯域制限 → 8kHz IMA-ADPCM(4bit) → 送信
//               受信 → デコード → 送信元ごとにジッタ吸収して再生 → 帯域制限・歪み → 出力
// 送信フレーム: [1][codec=1(ADPCM)][flags bit0=試験トーン][payload 83バイト]  (20msごと。サーバーが録音のためにデコードする)
// 受信フレーム: [1][codec][kind 0=指令 1=列車 2=試験トーン][srcId u16][payload]
(function (root) {
  const FRAME_MS = 20, JITTER = 0.07, MAX_AHEAD = 0.4;
  const WORKLET = `class Cap extends AudioWorkletProcessor{constructor(o){super();this.n=o.processorOptions.frame;this.b=new Float32Array(this.n);this.i=0}
process(inp){const c=inp[0]&&inp[0][0];if(c){for(let k=0;k<c.length;k++){this.b[this.i++]=c[k];if(this.i===this.n){this.port.postMessage(this.b.slice());this.i=0}}}return true}}
registerProcessor('cap',Cap);`;

  class RadioAudio {
    constructor(opt) {
      this.send = opt.send; this.base = () => opt.base();
      this.srcs = new Map(); this.sfx = new Map(); this.heard = new Map();
      this.tx = false; this.toneUntil = 0;
      this.vol = { disp: 0.7, train: 0.7 }; this.fx = { drive: 5 }; this.bootId = '';
    }
    async init() {
      if (this.ctx) { if (this.ctx.state !== 'running') await this.ctx.resume(); return; }
      const AC = root.AudioContext || root.webkitAudioContext; const c = (this.ctx = (() => { try { return new AC({ sampleRate: 48000, latencyHint: 'interactive' }); } catch (e) { return new AC(); } })());
      await c.resume();
      this.master = c.createGain(); this.master.connect(c.destination);
      this.gDisp = c.createGain(); this.gTrain = c.createGain(); this.fxIn = c.createGain();
      const hp = c.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 320;
      const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3000;
      this.shaper = c.createWaveShaper(); this.fxIn.connect(hp); hp.connect(lp); lp.connect(this.shaper); this.shaper.connect(this.master);
      this.gDisp.connect(this.fxIn); this.gTrain.connect(this.fxIn);
      this.setVolumes(this.vol); this.setFx(this.fx);
      // 送信系
      const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' })); await c.audioWorklet.addModule(url);
      this.cap = new AudioWorkletNode(c, 'cap', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], processorOptions: { frame: Math.round(c.sampleRate * FRAME_MS / 1000) } });
      const silent = c.createGain(); silent.gain.value = 0; this.cap.connect(silent); silent.connect(c.destination);
      this.cap.port.onmessage = (e) => this._onFrame(e.data);
      this.micHp = c.createBiquadFilter(); this.micHp.type = 'highpass'; this.micHp.frequency.value = 300;
      this.micLp = c.createBiquadFilter(); this.micLp.type = 'lowpass'; this.micLp.frequency.value = 3400;
      this.micGate = c.createGain(); this.micGate.gain.value = 0; this.monGain = c.createGain(); this.monGain.gain.value = 0;
      this.micHp.connect(this.micLp); this.micLp.connect(this.micGate); this.micGate.connect(this.cap);
      this.micLp.connect(this.monGain); this.monGain.connect(this.fxIn);                 // マイク確認モード(無線加工後の音を聞く)
      this.an = c.createAnalyser(); this.an.fftSize = 512; this.micLp.connect(this.an);
      setInterval(() => { const n = performance.now(); for (const [id, s] of this.srcs) if (n - s.last > 10000) { if (s.dec) try { s.dec.close(); } catch (e) {} this.srcs.delete(id); } }, 5000);
    }
    async startMic(deviceId) {
      if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: deviceId ? { exact: deviceId } : undefined, echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
      if (this.micSrc) this.micSrc.disconnect();
      this.micSrc = this.ctx.createMediaStreamSource(this.stream); this.micSrc.connect(this.micHp);
    }
    async setOutput(id) { if (this.ctx && this.ctx.setSinkId) try { await this.ctx.setSinkId(id || ''); } catch (e) {} }
    setVolumes(v) { Object.assign(this.vol, v); if (!this.ctx) return; this.gDisp.gain.value = this.vol.disp; this.gTrain.gain.value = this.vol.train; }
    setFx(f) {
      Object.assign(this.fx, f); if (!this.ctx) return;
      const k = 1 + this.fx.drive * 0.8, N = 1024, cur = new Float32Array(N);
      for (let i = 0; i < N; i++) { const x = (i / (N - 1)) * 2 - 1; cur[i] = Math.tanh(x * k) / Math.tanh(k); }
      this.shaper.curve = cur;
    }
    setTx(on) { this.tx = !!on; if (this.micGate) this.micGate.gain.setTargetAtTime(on ? 1 : 0, this.ctx.currentTime, 0.01); }
    setMonitor(on) { if (this.monGain) this.monGain.gain.value = on ? 1 : 0; }
    level() { if (!this.an) return 0; const b = new Float32Array(this.an.fftSize); this.an.getFloatTimeDomainData(b); let s = 0; for (const v of b) s += v * v; return Math.min(1, Math.sqrt(s / b.length) * 4); }

    // ---- 送信
    _onFrame(f32) {
      const toneOn = performance.now() < this.toneUntil;
      if (!this.tx && !toneOn) return;
      const ratio = this.ctx.sampleRate / 8000, pcm = new Float32Array(160);          // 8kHzへ(区間平均)
      for (let i = 0; i < 160; i++) { const a = Math.floor(i * ratio), b = Math.max(a + 1, Math.floor((i + 1) * ratio)); let s = 0; for (let k = a; k < b && k < f32.length; k++) s += f32[k]; pcm[i] = s / (b - a); }
      const p = ADPCM.encode(pcm), u = new Uint8Array(3 + p.length); u[0] = 1; u[1] = 1; u[2] = toneOn ? 1 : 0; u.set(p, 3); this.send(u);
    }
    async sendTone(ms) { // 800Hz試験トーンを通常の送話経路に流す(通話中なら通話に混ざる=妨害できる)
      const buf = await this._load('tone800'); if (!buf) return;
      const s = this.ctx.createBufferSource(); s.buffer = buf; s.connect(this.cap); this.toneUntil = performance.now() + ms; s.start(); s.stop(this.ctx.currentTime + ms / 1000);
    }

    // ---- 受信
    onAudio(ab) {
      if (!this.ctx) return; const u = new Uint8Array(ab); if (u.length < 6 || u[0] !== 1) return;
      const codec = u[1], kind = u[2], id = (u[3] << 8) | u[4], payload = u.subarray(5);
      let s = this.srcs.get(id); if (!s) { s = { id, kind, next: 0, last: 0, dec: null, ts: 0 }; this.srcs.set(id, s); }
      s.kind = kind; s.last = performance.now();
      if (kind !== 2) this.heard.set(id, s.last);
      if (codec === 1) this._play(s, ADPCM.decode(payload, 160), 8000);
    }
    _play(s, f, rate) {
      const c = this.ctx, now = c.currentTime;
      if (s.next > now + MAX_AHEAD) return;                  // 遅延が溜まったら古い音声を捨てて追いつく
      const ab = c.createBuffer(1, f.length, rate); ab.copyToChannel(f, 0);
      const n = c.createBufferSource(); n.buffer = ab; n.connect(s.kind === 0 ? this.gDisp : this.gTrain);
      let t = s.next; if (t < now + 0.01) t = now + JITTER;
      n.start(t); s.next = t + ab.duration;
    }

    // ---- 効果音(サーバーのsounds/*.wav)
    async _load(name) {
      if (this.sfx.has(name)) return this.sfx.get(name);
      const p = fetch(`${this.base()}/sounds/${name}.wav?v=${this.bootId}`).then((r) => r.arrayBuffer()).then((b) => this.ctx.decodeAudioData(b)).catch(() => null);
      this.sfx.set(name, p); return p;
    }
    // bus: 'disp'(無線エフェクトあり・指令音量に連動) / 'master'
    async play(name, { loop = false, bus = 'master' } = {}) {
      const buf = await this._load(name); if (!buf) return { stop() {} };
      const s = this.ctx.createBufferSource(); s.buffer = buf; s.loop = loop; s.connect(bus === 'disp' ? this.gDisp : this.master); s.start();
      let stopped = false; return { stop: () => { if (!stopped) { stopped = true; try { s.stop(); } catch (e) {} } } };
    }
  }
  root.RadioAudio = RadioAudio;
})(typeof self !== 'undefined' ? self : this);
