// IMA ADPCM(4bit)。WebCodecsのOpusが使えない端末向けのフォールバック。1パケットで完結(欠落に強い)。
(function (root) {
  const STEP = [7,8,9,10,11,12,13,14,16,17,19,21,23,25,28,31,34,37,41,45,50,55,60,66,73,80,88,97,107,118,130,143,157,173,190,209,230,253,279,307,337,371,408,449,494,544,598,658,724,796,876,963,1060,1166,1282,1411,1552,1707,1878,2066,2272,2499,2749,3024,3327,3660,4026,4428,4871,5358,5894,6484,7132,7845,8630,9493,10442,11487,12635,13899,15289,16818,18500,20350,22385,24623,27086,29794,32767];
  const IDX = [-1, -1, -1, -1, 2, 4, 6, 8];
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const toI16 = (f) => clamp(Math.round(f * 32767), -32768, 32767);
  // pcm: Float32Array(8kHz) → Uint8Array [pred lo, pred hi, index, nibbles...]
  function encode(pcm) {
    const n = pcm.length, out = new Uint8Array(3 + (n >> 1) + 1);
    let pred = toI16(pcm[0]), index = 0;
    out[0] = pred & 255; out[1] = (pred >> 8) & 255; out[2] = 0;
    let o = 3, hi = false, byte = 0;
    for (let i = 1; i < n; i++) {
      let diff = toI16(pcm[i]) - pred, code = 0;
      if (diff < 0) { code = 8; diff = -diff; }
      let step = STEP[index], vp = step >> 3;
      if (diff >= step) { code |= 4; diff -= step; vp += step; }
      step >>= 1; if (diff >= step) { code |= 2; diff -= step; vp += step; }
      step >>= 1; if (diff >= step) { code |= 1; vp += step; }
      pred = clamp(pred + (code & 8 ? -vp : vp), -32768, 32767);
      index = clamp(index + IDX[code & 7], 0, 88);
      if (!hi) { byte = code; hi = true; } else { out[o++] = byte | (code << 4); hi = false; }
    }
    if (hi) out[o++] = byte;
    return out.subarray(0, o);
  }
  function decode(bytes, n) {
    n = n || 160; const out = new Float32Array(n);
    let pred = (bytes[0] | (bytes[1] << 8)) << 16 >> 16, index = clamp(bytes[2], 0, 88);
    out[0] = pred / 32768;
    for (let i = 1; i < n; i++) {
      const k = i - 1, b = bytes[3 + (k >> 1)]; if (b === undefined) break;
      const code = (k & 1) ? b >> 4 : b & 15;
      const step = STEP[index]; let vp = step >> 3;
      if (code & 4) vp += step; if (code & 2) vp += step >> 1; if (code & 1) vp += step >> 2;
      pred = clamp(pred + (code & 8 ? -vp : vp), -32768, 32767);
      index = clamp(index + IDX[code & 7], 0, 88);
      out[i] = pred / 32768;
    }
    return out;
  }
  const api = { encode, decode };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.ADPCM = api;
})(typeof self !== 'undefined' ? self : this);
