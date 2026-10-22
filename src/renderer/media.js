const M = { name: '', kind: '', samples: [], clip: null, busy: false, rasters: [], rw: 0, rh: 0 };

function mediaSettings() {
  return {
    fit: $('#mFit').value,
    flip: $('#mFlip').checked,
    gamma: +$('#mGamma').value,
    sat: +$('#mSat').value,
    bright: +$('#mBright').value,
    maxSec: +$('#mMaxSec').value,
    speed: +$('#mSpeed').value,
  };
}

function deviceFps() {
  const rates = S.scene.devices.map((d) => Math.floor(d.frameRate || 13));
  return Math.max(1, Math.min(rates.length ? Math.min(...rates) : 13, 20));
}

function once(el, ev) { return new Promise((res) => el.addEventListener(ev, res, { once: true })); }

function shrink(src, w, h, maxEdge) {
  let cw = w, ch = h, cur = src;
  while (Math.max(cw, ch) > maxEdge * 2) {
    const nw = Math.max(1, Math.round(cw / 2)), nh = Math.max(1, Math.round(ch / 2));
    const c = document.createElement('canvas'); c.width = nw; c.height = nh;
    const g = c.getContext('2d'); g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
    g.drawImage(cur, 0, 0, cw, ch, 0, 0, nw, nh);
    cur = c; cw = nw; ch = nh;
  }
  const scale = Math.min(1, maxEdge / Math.max(cw, ch));
  const fw = Math.max(1, Math.round(cw * scale)), fh = Math.max(1, Math.round(ch * scale));
  const out = document.createElement('canvas'); out.width = fw; out.height = fh;
  const g = out.getContext('2d'); g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
  g.drawImage(cur, 0, 0, cw, ch, 0, 0, fw, fh);
  return out;
}

async function decodeAnimated(file) {
  const type = file.type || 'image/gif';
  const supported = typeof ImageDecoder !== 'undefined' && (await ImageDecoder.isTypeSupported(type).catch(() => false));
  const samples = [];
  if (supported) {
    const dec = new ImageDecoder({ data: await file.arrayBuffer(), type });
    await dec.tracks.ready;
    const track = dec.tracks.selectedTrack;
    const count = Math.max(1, track.frameCount || 1);
    for (let i = 0; i < count; i++) {
      const { image } = await dec.decode({ frameIndex: i });
      const dur = image.duration ? image.duration / 1e6 : 0.1;
      const w = image.displayWidth, h = image.displayHeight;
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      c.getContext('2d').drawImage(image, 0, 0);
      image.close();
      samples.push({ img: shrink(c, w, h, 256), dt: Math.max(0.02, dur) });
      if (i % 20 === 0) mediaStatus(`Decoding frame ${i + 1} of ${count}...`);
    }
    dec.close();
  } else {
    const bmp = await createImageBitmap(file);
    samples.push({ img: shrink(bmp, bmp.width, bmp.height, 256), dt: 1 });
    bmp.close();
  }
  return samples;
}

async function decodeVideo(file, fps, maxSec, speed) {
  const v = document.createElement('video');
  v.muted = true; v.playsInline = true; v.preload = 'auto';
  v.src = URL.createObjectURL(file);
  await once(v, 'loadedmetadata');
  const step = speed / fps;
  const total = Math.min(v.duration, maxSec * speed);
  const n = Math.max(1, Math.floor(total / step));
  const samples = [];
  for (let k = 0; k < n; k++) {
    v.currentTime = Math.min(v.duration - 0.001, k * step);
    await once(v, 'seeked');
    const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight;
    c.getContext('2d').drawImage(v, 0, 0);
    samples.push({ img: shrink(c, c.width, c.height, 256), dt: 1 / fps });
    if (k % 10 === 0) mediaStatus(`Grabbing video frame ${k + 1} of ${n}...`);
  }
  URL.revokeObjectURL(v.src);
  return samples;
}

function sceneAspect() {
  const b = bounds();
  return ((b.maxx - b.minx) || 1) / ((b.maxy - b.miny) || 1);
}

function ledCoords() {
  const b = bounds();
  const sx = (b.maxx - b.minx) || 1, sy = (b.maxy - b.miny) || 1;
  return S.scene.devices.map((d) => ({ id: d.id, uv: d.layout.map((c) => { const [wx, wy] = localToWorld(d.place, c.x, c.y); return [(wx - b.minx) / sx, (wy - b.miny) / sy]; }) }));
}

function rasterize(sample, rw, rh, fit) {
  const c = document.createElement('canvas'); c.width = rw; c.height = rh;
  const g = c.getContext('2d');
  g.fillStyle = '#000'; g.fillRect(0, 0, rw, rh);
  g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
  const iw = sample.img.width, ih = sample.img.height;
  let dx = 0, dy = 0, dw = rw, dh = rh;
  if (fit !== 'stretch') {
    const s = fit === 'cover' ? Math.max(rw / iw, rh / ih) : Math.min(rw / iw, rh / ih);
    dw = iw * s; dh = ih * s; dx = (rw - dw) / 2; dy = (rh - dh) / 2;
  }
  const pre = shrink(sample.img, iw, ih, Math.max(dw, dh));
  g.drawImage(pre, dx, dy, dw, dh);
  return g.getImageData(0, 0, rw, rh);
}

function sampleBilinear(data, rw, rh, x, y) {
  x = Math.min(rw - 1, Math.max(0, x)); y = Math.min(rh - 1, Math.max(0, y));
  const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(rw - 1, x0 + 1), y1 = Math.min(rh - 1, y0 + 1);
  const fx = x - x0, fy = y - y0;
  const out = [0, 0, 0];
  for (let ch = 0; ch < 3; ch++) {
    const a = data[(y0 * rw + x0) * 4 + ch], b = data[(y0 * rw + x1) * 4 + ch], c = data[(y1 * rw + x0) * 4 + ch], d = data[(y1 * rw + x1) * 4 + ch];
    out[ch] = (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
  }
  return out;
}

function colorize(rgb, st) {
  let [r, g, b] = rgb.map((c) => 255 * Math.pow(c / 255, st.gamma));
  const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  r = (l + (r - l) * st.sat) * st.bright; g = (l + (g - l) * st.sat) * st.bright; b = (l + (b - l) * st.sat) * st.bright;
  return [r, g, b].map((c) => (c < 0 ? 0 : c > 255 ? 255 : Math.round(c)));
}

function buildTimeline(samples, fps, maxSec, speed) {
  const total = Math.min(maxSec, samples.reduce((a, s) => a + s.dt, 0) / speed);
  const n = Math.max(1, Math.floor(total * fps));
  const idx = new Array(n);
  let si = 0, acc = samples[0].dt / speed;
  for (let k = 0; k < n; k++) {
    const t = k / fps;
    while (t >= acc && si < samples.length - 1) { si++; acc += samples[si].dt / speed; }
    idx[k] = si;
  }
  return idx;
}

function buildClip() {
  if (!M.samples.length || !S.scene.devices.length) return;
  const st = mediaSettings();
  const fps = deviceFps();
  const aspect = sceneAspect();
  const rw = Math.max(4, aspect >= 1 ? 64 : Math.round(64 * aspect));
  const rh = Math.max(4, aspect >= 1 ? Math.round(64 / aspect) : 64);
  const coords = ledCoords();
  const timeline = M.kind === 'video' ? M.samples.map((_, i) => i) : buildTimeline(M.samples, fps, st.maxSec, st.speed);
  const rasterCache = new Map();
  const perDevice = {};
  for (const d of coords) perDevice[d.id] = new Uint8Array(timeline.length * d.uv.length * 3);
  M.rasters = [];
  timeline.forEach((si, k) => {
    let img = rasterCache.get(si);
    if (!img) { img = rasterize(M.samples[si], rw, rh, st.fit); rasterCache.set(si, img); }
    M.rasters.push(img);
    for (const d of coords) {
      const out = perDevice[d.id];
      const base = k * d.uv.length * 3;
      d.uv.forEach(([u, v], i) => {
        const y = (st.flip ? v : 1 - v) * rh - 0.5;
        const rgb = colorize(sampleBilinear(img.data, rw, rh, u * rw - 0.5, y), st);
        out[base + 3 * i] = rgb[0]; out[base + 3 * i + 1] = rgb[1]; out[base + 3 * i + 2] = rgb[2];
      });
    }
  });
  M.rw = rw; M.rh = rh;
  M.clip = { fps, count: timeline.length, devices: perDevice };
  const secs = (timeline.length / fps).toFixed(1);
  $('#mInfo').textContent = `${M.name}: ${timeline.length} frames at ${fps} fps (${secs} s), raster ${rw}×${rh}`;
  const cap = Math.min(...S.scene.devices.map((d) => d.movieCapacity || 6342));
  $('#mCap').textContent = `Uses ${timeline.length} of ${cap} stored-movie frames if uploaded.`;
  ['#mPlay', '#mUpload', '#mPreset'].forEach((s) => ($(s).disabled = false));
  playNow();
}

async function playNow() {
  if (!M.clip) return;
  drawThumb(0);
  await safe(window.api.mediaPlay({ clip: clipForIpc(), source: M.name }), `${M.name} is on the lights`);
  poll();
}

function drawThumb(k) {
  const pc = $('#mPreview'), g = pc.getContext('2d');
  const img = M.rasters[k];
  if (!img) return;
  g.imageSmoothingEnabled = false;
  const tmp = document.createElement('canvas'); tmp.width = M.rw; tmp.height = M.rh; tmp.getContext('2d').putImageData(img, 0, 0);
  g.clearRect(0, 0, pc.width, pc.height);
  const s = Math.min(pc.width / M.rw, pc.height / M.rh);
  g.drawImage(tmp, (pc.width - M.rw * s) / 2, (pc.height - M.rh * s) / 2, M.rw * s, M.rh * s);
}

function liveIsThisClip() { return !!(S.live && S.live.pattern === 'media' && S.live.source === M.name); }

function onLiveFrame(idx) { if (idx != null && M.clip && liveIsThisClip()) drawThumb(idx % M.clip.count); }

function mediaStatus(t) { $('#mInfo').textContent = t; }

async function loadMediaFile(file) {
  if (!file || M.busy) return;
  if (!S.scene.devices.length) return status('Add a set first so the picture has somewhere to go');
  M.busy = true;
  ['#mPlay', '#mUpload', '#mPreset'].forEach((s) => ($(s).disabled = true));
  try {
    M.name = file.name;
    const st = mediaSettings();
    if (file.type.startsWith('video/')) { M.kind = 'video'; M.samples = await decodeVideo(file, deviceFps(), st.maxSec, st.speed); }
    else { M.kind = 'image'; M.samples = await decodeAnimated(file); }
    M.file = file;
    buildClip();
  } catch (e) {
    mediaStatus('Could not read that file: ' + (e.message || e));
  } finally { M.busy = false; }
}

let rebuildT = 0;
function scheduleRebuild() {
  clearTimeout(rebuildT);
  rebuildT = setTimeout(async () => {
    if (!M.samples.length) return;
    if (M.kind === 'video' && M.file) { await loadMediaFile(M.file); return; }
    buildClip();
  }, 150);
}

const drop = $('#mDrop');
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); loadMediaFile(e.dataTransfer.files[0]); });
drop.addEventListener('click', () => $('#mFile').click());
$('#mFile').onchange = () => loadMediaFile($('#mFile').files[0]);
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => { e.preventDefault(); if (e.target !== drop && !drop.contains(e.target)) loadMediaFile(e.dataTransfer.files[0]); });

['mFit', 'mFlip', 'mGamma', 'mSat', 'mBright', 'mMaxSec', 'mSpeed'].forEach((id) => {
  const el = $('#' + id);
  el.addEventListener(el.type === 'range' ? 'input' : 'change', () => {
    const v = $('#' + id + 'Val'); if (v) v.textContent = (+el.value).toFixed(2);
    scheduleRebuild();
  });
});

function clipForIpc() { return { fps: M.clip.fps, count: M.clip.count, devices: M.clip.devices }; }

$('#mPlay').onclick = () => playNow();
$('#mStop').onclick = async () => { await safe(window.api.liveStop({}), 'Stopped. The lights are back to what they were doing before.'); S.frames = {}; poll(); };
$('#mUpload').onclick = async () => {
  if (!M.clip) return;
  status('Storing on every set...');
  const r = await safe(window.api.mediaSave({ title: ($('#mTitle').value || M.name).slice(0, 31), clip: clipForIpc() }));
  if (r) status(S.scene.devices.map((d) => { const x = r[d.id] || {}; return `${d.name}: ${x.error ? x.error : `stored, ${x.frames} frames at ${x.fps} fps, playing from the string's own memory`}`; }).join(' · '));
  poll();
};
$('#mPreset').onclick = async () => {
  if (!M.clip) return;
  const name = ($('#mTitle').value || M.name.replace(/\.[^.]+$/, '')).trim();
  await safe(window.api.mediaPreset({ name, clip: clipForIpc(), source: M.name, brightness: +$('#bri').value }), `Saved media preset "${name}"`);
};

window.api.onChanged((what) => { if (what === 'scene' && M.samples.length) scheduleRebuild(); });
