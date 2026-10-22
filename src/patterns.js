const DEFAULTS = { color1: '#ff5a00', color2: '#0040ff', speed: 0.3, scale: 1.0, angle: 90, density: 0.5, index: 0 };

const PATTERNS = ['solid', 'gradient', 'rainbow', 'wave', 'twinkle', 'rain', 'chase', 'plasma', 'columns', 'sparkle', 'identify'];

function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const cache = new Map();
function perLed(n, key, fn) {
  const k = `${n}:${key}`;
  if (!cache.has(k)) cache.set(k, fn());
  return cache.get(k);
}

function hexRgb(h) {
  const s = String(h || '').replace('#', '');
  if (s.length !== 6) return [255, 255, 255];
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
}

function hsv(h, s, v, out, i) {
  h = ((h % 1) + 1) % 1 * 6;
  const k = Math.floor(h) % 6;
  const f = h - Math.floor(h);
  const p = v * (1 - s), q = v * (1 - s * f), t = v * (1 - s * (1 - f));
  let r, g, b;
  switch (k) {
    case 0: r = v; g = t; b = p; break;
    case 1: r = q; g = v; b = p; break;
    case 2: r = p; g = v; b = t; break;
    case 3: r = p; g = q; b = v; break;
    case 4: r = t; g = p; b = v; break;
    default: r = v; g = p; b = q;
  }
  out[i] = r; out[i + 1] = g; out[i + 2] = b;
}

function lerp(c1, c2, u, out, i) {
  u = u < 0 ? 0 : u > 1 ? 1 : u;
  out[i] = c1[0] + (c2[0] - c1[0]) * u;
  out[i + 1] = c1[1] + (c2[1] - c1[1]) * u;
  out[i + 2] = c1[2] + (c2[2] - c1[2]) * u;
}

function project(pts, angle) {
  const a = (angle * Math.PI) / 180;
  const ca = Math.cos(a), sa = Math.sin(a);
  const n = pts.length / 2;
  const out = new Float32Array(n);
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < n; i++) {
    const v = pts[2 * i] * ca + pts[2 * i + 1] * sa;
    out[i] = v;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const span = hi - lo || 1;
  for (let i = 0; i < n; i++) out[i] = (out[i] - lo) / span;
  return out;
}

const FUNCS = {
  solid(pts, t, p, c1, c2, out, n) {
    for (let i = 0; i < n; i++) lerp(c1, c1, 0, out, 3 * i);
  },
  gradient(pts, t, p, c1, c2, out, n) {
    const u = project(pts, p.angle);
    for (let i = 0; i < n; i++) {
      const v = ((u[i] * p.scale + t * p.speed) % 1 + 1) % 1;
      lerp(c1, c2, 1 - Math.abs(2 * v - 1), out, 3 * i);
    }
  },
  rainbow(pts, t, p, c1, c2, out, n) {
    const u = project(pts, p.angle);
    for (let i = 0; i < n; i++) hsv(u[i] * p.scale + t * p.speed, 1, 255, out, 3 * i);
  },
  wave(pts, t, p, c1, c2, out, n) {
    const u = project(pts, p.angle);
    for (let i = 0; i < n; i++) lerp(c1, c2, 0.5 + 0.5 * Math.sin(2 * Math.PI * (u[i] * p.scale - t * p.speed)), out, 3 * i);
  },
  twinkle(pts, t, p, c1, c2, out, n) {
    const phase = perLed(n, 'twp', () => { const r = mulberry(7); return Float32Array.from({ length: n }, () => r() * 2 * Math.PI); });
    const rate = perLed(n, 'twr', () => { const r = mulberry(11); return Float32Array.from({ length: n }, () => 0.5 + r()); });
    const dim = [c1[0] * 0.12, c1[1] * 0.12, c1[2] * 0.12];
    const pw = 1 + (1 - p.density) * 8;
    for (let i = 0; i < n; i++) {
      const s = Math.sin(t * p.speed * 2 * Math.PI * rate[i] + phase[i]);
      lerp(dim, c2, Math.pow(Math.max(0, s), pw), out, 3 * i);
    }
  },
  rain(pts, t, p, c1, c2, out, n) {
    const cols = Math.max(1, Math.round(3 + p.scale * 6));
    const phases = perLed(cols, 'rainp', () => { const r = mulberry(5); return Float32Array.from({ length: cols }, () => r()); });
    const dim = [c1[0] * 0.08, c1[1] * 0.08, c1[2] * 0.08];
    const tail = 0.05 + 0.4 * p.density;
    for (let i = 0; i < n; i++) {
      const col = Math.min(cols - 1, Math.max(0, Math.floor(pts[2 * i] * cols)));
      const head = 1 - (((t * p.speed + phases[col]) % 1 + 1) % 1);
      const dist = ((pts[2 * i + 1] - head) % 1 + 1) % 1;
      lerp(dim, c2, Math.exp(-dist / tail), out, 3 * i);
    }
  },
  chase(pts, t, p, c1, c2, out, n) {
    const dim = [c1[0] * 0.08, c1[1] * 0.08, c1[2] * 0.08];
    const k = 0.03 + 0.3 * p.density;
    for (let i = 0; i < n; i++) {
      const v = (((i / n) * p.scale * 4 - t * p.speed) % 1 + 1) % 1;
      lerp(dim, c2, Math.exp(-v / k), out, 3 * i);
    }
  },
  plasma(pts, t, p, c1, c2, out, n) {
    const k = 3 * p.scale;
    for (let i = 0; i < n; i++) {
      const x = pts[2 * i], y = pts[2 * i + 1];
      const v = Math.sin(x * k + t * p.speed * 2) + Math.sin(y * k + t * p.speed * 1.3) + Math.sin((x + y) * k * 0.7 + t * p.speed * 0.7);
      hsv(v / 6 + 0.5, 1, 255, out, 3 * i);
    }
  },
  columns(pts, t, p, c1, c2, out, n) {
    const cols = Math.max(1, Math.round(3 + p.scale * 6));
    const dim = [c1[0] * 0.1, c1[1] * 0.1, c1[2] * 0.1];
    const k = 0.05 + 0.4 * p.density;
    for (let i = 0; i < n; i++) {
      const col = Math.min(cols - 1, Math.max(0, Math.floor(pts[2 * i] * cols)));
      const v = ((col / cols - t * p.speed) % 1 + 1) % 1;
      lerp(dim, c2, Math.exp(-v / k), out, 3 * i);
    }
  },
  sparkle(pts, t, p, c1, c2, out, n) {
    const seeds = perLed(n, 'spk', () => { const r = mulberry(3); return Float32Array.from({ length: n }, () => r()); });
    const period = 0.3 + (1 - p.density) * 2;
    for (let i = 0; i < n; i++) {
      const phase = ((t * p.speed * 2 + seeds[i] * period * 10) % period) / period;
      const g = phase < 0.15 ? phase / 0.15 : Math.max(0, 1 - (phase - 0.15) / 0.5);
      lerp(c1, c2, g, out, 3 * i);
    }
  },
  identify(pts, t, p, c1, c2, out, n) {
    out.fill(0);
    const i = Math.round(p.index);
    if (i >= 0 && i < n) { out[3 * i] = 255; out[3 * i + 1] = 255; out[3 * i + 2] = 255; }
  },
};

function render(name, pts, t, params) {
  const p = Object.assign({}, DEFAULTS, params || {});
  const n = pts.length / 2;
  const out = new Float32Array(n * 3);
  (FUNCS[name] || FUNCS.solid)(pts, t, p, hexRgb(p.color1), hexRgb(p.color2), out, n);
  const bytes = Buffer.alloc(n * 3);
  for (let i = 0; i < out.length; i++) bytes[i] = out[i] < 0 ? 0 : out[i] > 255 ? 255 : Math.round(out[i]);
  return bytes;
}

module.exports = { DEFAULTS, PATTERNS, render };
