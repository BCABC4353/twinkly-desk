const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

const S = {
  scene: { devices: [], units: 'in' },
  patterns: [],
  live: null,
  status: {},
  frames: {},
  tool: 'view',
  sel: null,
  hover: null,
  drag: null,
  dirty: {},
  fx: 0,
  presets: {},
  schedule: [],
  idTimer: 0,
};

function status(t) { $('#status').textContent = t; }
function perSetResult(r, okMsg) {
  if (!r || typeof r !== 'object') return;
  const errs = S.scene.devices.filter((d) => r[d.id] && r[d.id].error).map((d) => `${d.name}: ${r[d.id].error}`);
  status(errs.length ? errs.join(' · ') : okMsg || '');
}

async function safe(p, okMsg) {
  try { const r = await p; if (okMsg) status(okMsg); return r; }
  catch (e) { status('Error: ' + (e.message || e).replace(/^Error invoking remote method '[^']+': Error: /, '')); return null; }
}

function localToWorld(place, lx, ly) {
  const a = (place.rot * Math.PI) / 180, ca = Math.cos(a), sa = Math.sin(a);
  const dx = ((lx + 1) / 2 - 0.5) * place.w, dy = (ly - 0.5) * place.h;
  const cx = place.x + place.w / 2, cy = place.y + place.h / 2;
  return [cx + dx * ca - dy * sa, cy + dx * sa + dy * ca];
}
function worldToLocal(place, wx, wy) {
  const a = (-place.rot * Math.PI) / 180, ca = Math.cos(a), sa = Math.sin(a);
  const cx = place.x + place.w / 2, cy = place.y + place.h / 2;
  const ex = wx - cx, ey = wy - cy;
  const dx = ex * ca - ey * sa, dy = ex * sa + ey * ca;
  return [(dx / place.w + 0.5) * 2 - 1, dy / place.h + 0.5];
}
function corners(place) { return [[-1, 0], [1, 0], [1, 1], [-1, 1]].map(([x, y]) => localToWorld(place, x, y)); }
function inPoly(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

const cv = $('#cv'), ctx = cv.getContext('2d');
let V = { minx: 0, maxx: 1, miny: 0, maxy: 1, s: 1, ox: 0, oy: 0 };
let fitPending = true;

function bounds() {
  let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
  for (const d of S.scene.devices) for (const [x, y] of corners(d.place)) { minx = Math.min(minx, x); maxx = Math.max(maxx, x); miny = Math.min(miny, y); maxy = Math.max(maxy, y); }
  if (!isFinite(minx)) return { minx: 0, maxx: 100, miny: 0, maxy: 100 };
  return { minx, maxx, miny, maxy };
}
function fit() {
  const b = bounds();
  const W = cv.width, H = cv.height, pad = 60;
  const sx = (W - 2 * pad) / ((b.maxx - b.minx) || 1), sy = (H - 2 * pad) / ((b.maxy - b.miny) || 1);
  const s = Math.min(sx, sy);
  V = { ...b, s, ox: (W - s * (b.maxx - b.minx)) / 2, oy: (H - s * (b.maxy - b.miny)) / 2 };
  fitPending = false;
}
function toPx(wx, wy) { return [V.ox + (wx - V.minx) * V.s, V.oy + (V.maxy - wy) * V.s]; }
function toWorld(px, py) { return [V.minx + (px - V.ox) / V.s, V.maxy - (py - V.oy) / V.s]; }

function resize() {
  const r = cv.parentElement.getBoundingClientRect();
  cv.width = Math.max(100, Math.round(r.width * devicePixelRatio));
  cv.height = Math.max(100, Math.round(r.height * devicePixelRatio));
  fit();
  draw();
}

function draw() {
  if (fitPending) fit();
  ctx.clearRect(0, 0, cv.width, cv.height);
  const dpr = devicePixelRatio;
  const live = !!S.live || Object.keys(S.frames).length > 0;
  for (const d of S.scene.devices) {
    const poly = corners(d.place).map(([x, y]) => toPx(x, y));
    const selected = S.sel === d.id;
    ctx.lineWidth = (selected ? 1.5 : 1) * dpr;
    ctx.strokeStyle = selected ? '#4fa3ff' : S.tool === 'arrange' ? '#3a4150' : '#1f242e';
    ctx.setLineDash(S.tool === 'arrange' ? [] : [4 * dpr, 4 * dpr]);
    ctx.beginPath(); poly.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]))); ctx.closePath(); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = selected ? '#4fa3ff' : '#6b7280';
    ctx.font = `${11 * dpr}px system-ui`;
    ctx.fillText(`${d.name}${d.online === false ? ' (offline)' : ''}`, poly[3][0] + 4 * dpr, poly[3][1] - 6 * dpr);
    if (S.tool === 'arrange' && selected) {
      const h = poly[2];
      ctx.fillStyle = '#4fa3ff'; ctx.fillRect(h[0] - 5 * dpr, h[1] - 5 * dpr, 10 * dpr, 10 * dpr);
    }
    const pts = d.layout.map((c) => { const [wx, wy] = localToWorld(d.place, c.x, c.y); return toPx(wx, wy); });
    d._pts = pts;
    ctx.lineWidth = dpr; ctx.strokeStyle = '#2b3140';
    ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]))); ctx.stroke();
    const f = S.frames[d.id];
    const r = Math.max(2.5, Math.min(7, V.s * (d.place.w / Math.max(1, Math.sqrt(d.layout.length) * 2)) * 0.35)) * dpr;
    pts.forEach((p, i) => {
      let col = '#3a4150';
      if (f && f.length >= 3 * i + 3) col = `rgb(${f[3 * i]},${f[3 * i + 1]},${f[3 * i + 2]})`;
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.arc(p[0], p[1], r, 0, Math.PI * 2); ctx.fill();
      if (S.hover && S.hover.id === d.id && S.hover.i === i) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 2 * dpr; ctx.stroke(); }
      if ($('#showIdx').checked) { ctx.fillStyle = '#9aa3b8'; ctx.font = `${9 * dpr}px system-ui`; ctx.fillText(i, p[0] + r + 1, p[1] - r); }
    });
    const orig = S.dirty[d.id];
    if (orig) {
      ctx.strokeStyle = '#ff9f43'; ctx.lineWidth = dpr; ctx.setLineDash([3 * dpr, 3 * dpr]);
      orig.forEach((c, i) => {
        const [wx, wy] = localToWorld(d.place, c.x, c.y); const o = toPx(wx, wy), p = pts[i];
        if (Math.abs(o[0] - p[0]) + Math.abs(o[1] - p[1]) > 1) { ctx.beginPath(); ctx.moveTo(o[0], o[1]); ctx.lineTo(p[0], p[1]); ctx.stroke(); }
      });
      ctx.setLineDash([]);
    }
  }
  if (!S.scene.devices.length) {
    ctx.fillStyle = '#6b7280'; ctx.font = `${14 * dpr}px system-ui`; ctx.textAlign = 'center';
    ctx.fillText('No sets yet. Open the Sets tab, scan, and add your lights.', cv.width / 2, cv.height / 2); ctx.textAlign = 'left';
  }
  void live;
}

function nearestLed(mx, my) {
  let best = null, bd = 12 * devicePixelRatio;
  for (const d of S.scene.devices) (d._pts || []).forEach((p, i) => { const dist = Math.hypot(p[0] - mx, p[1] - my); if (dist < bd) { bd = dist; best = { id: d.id, i }; } });
  return best;
}
function deviceAt(wx, wy) {
  for (let k = S.scene.devices.length - 1; k >= 0; k--) { const d = S.scene.devices[k]; if (inPoly([wx, wy], corners(d.place))) return d; }
  return null;
}
function mouse(e) { const r = cv.getBoundingClientRect(); return [(e.clientX - r.left) * devicePixelRatio, (e.clientY - r.top) * devicePixelRatio, e.clientX - r.left, e.clientY - r.top]; }

cv.addEventListener('mousedown', (e) => {
  const [mx, my] = mouse(e);
  const [wx, wy] = toWorld(mx, my);
  if (S.tool === 'arrange') {
    const sel = S.scene.devices.find((d) => d.id === S.sel);
    if (sel) { const h = toPx(...corners(sel.place)[2]); if (Math.hypot(h[0] - mx, h[1] - my) < 10 * devicePixelRatio) { S.drag = { kind: 'resize', d: sel, start: [wx, wy], place: { ...sel.place } }; return; } }
    const d = deviceAt(wx, wy);
    S.sel = d ? d.id : null;
    if (d) S.drag = { kind: 'move', d, start: [wx, wy], place: { ...d.place } };
    renderDevices(); draw();
  } else if (S.tool === 'leds') {
    const h = nearestLed(mx, my);
    if (h) { const d = S.scene.devices.find((x) => x.id === h.id); if (!S.dirty[d.id]) S.dirty[d.id] = d.layout.map((c) => ({ ...c })); S.drag = { kind: 'led', d, i: h.i }; S.sel = d.id; }
  }
});
cv.addEventListener('mousemove', (e) => {
  const [mx, my, cx, cy] = mouse(e);
  const [wx, wy] = toWorld(mx, my);
  if (S.drag) {
    const g = S.drag;
    if (g.kind === 'move') { g.d.place.x = g.place.x + (wx - g.start[0]); g.d.place.y = g.place.y + (wy - g.start[1]); }
    else if (g.kind === 'resize') {
      const a = (g.place.rot * Math.PI) / 180;
      const ex = wx - g.start[0], ey = wy - g.start[1];
      const dw = ex * Math.cos(a) + ey * Math.sin(a), dh = -ex * Math.sin(a) + ey * Math.cos(a);
      g.d.place.w = Math.max(5, g.place.w + dw); g.d.place.h = Math.max(5, g.place.h + dh);
    } else if (g.kind === 'led') {
      const [lx, ly] = worldToLocal(g.d.place, wx, wy);
      g.d.layout[g.i] = { ...g.d.layout[g.i], x: lx, y: ly };
    }
    draw(); return;
  }
  const h = nearestLed(mx, my);
  const same = (h && S.hover && h.id === S.hover.id && h.i === S.hover.i) || (!h && !S.hover);
  if (!same) {
    S.hover = h; draw();
    const tip = $('#tip');
    if (h) { const d = S.scene.devices.find((x) => x.id === h.id); const c = d.layout[h.i]; tip.style.display = 'block'; tip.style.left = cx + 12 + 'px'; tip.style.top = cy - 8 + 'px'; tip.textContent = `${d.name} LED ${h.i} (${c.x.toFixed(3)}, ${c.y.toFixed(3)})`; }
    else tip.style.display = 'none';
    if ($('#idHover').checked && h) { clearTimeout(S.idTimer); S.idTimer = setTimeout(() => safe(window.api.identify({ id: h.id, index: h.i })), 60); }
  }
});
window.addEventListener('mouseup', async () => {
  const g = S.drag; S.drag = null;
  if (!g) return;
  if (g.kind === 'move' || g.kind === 'resize') { await safe(window.api.setPlace({ id: g.d.id, place: g.d.place })); renderDevices(); if (!S.live || S.live.pattern !== 'media') status('Arrangement saved. Live patterns follow it at once.'); }
  if (g.kind === 'led') renderDevices();
  draw();
});
cv.addEventListener('mouseleave', () => { S.hover = null; $('#tip').style.display = 'none'; draw(); });
cv.addEventListener('wheel', (e) => {
  if (S.tool !== 'arrange' || !S.sel || !e.shiftKey) return;
  const d = S.scene.devices.find((x) => x.id === S.sel); if (!d) return;
  d.place.rot = Math.round((d.place.rot + (e.deltaY > 0 ? 5 : -5)) % 360);
  safe(window.api.setPlace({ id: d.id, place: d.place })); renderDevices(); draw();
}, { passive: true });
window.addEventListener('resize', resize);

$$('#toolSeg button').forEach((b) => (b.onclick = () => {
  S.tool = b.dataset.tool;
  $$('#toolSeg button').forEach((x) => x.classList.toggle('on', x === b));
  $('#hint').textContent = S.tool === 'arrange' ? 'Drag a set to move it. Drag the blue corner to resize. Shift + wheel rotates the selected set.' : S.tool === 'leds' ? 'Drag an LED to fix its mapped position, then push the layout from the Sets tab.' : '';
  draw();
}));
$('#btnFit').onclick = () => { fit(); draw(); };
$('#showIdx').onchange = draw;

async function loadScene() {
  const r = await window.api.getScene();
  const hadDevices = S.scene.devices.length;
  const edited = {};
  for (const d of S.scene.devices) if (S.dirty[d.id]) edited[d.id] = d.layout;
  S.scene = r.scene; S.live = r.live;
  for (const d of S.scene.devices) if (edited[d.id] && edited[d.id].length === d.layout.length) d.layout = edited[d.id];
  if (!S.patterns.length) { S.patterns = r.patterns; const sel = $('#pat'); r.patterns.filter((p) => p !== 'identify').forEach((p) => { const o = document.createElement('option'); o.value = o.textContent = p; sel.appendChild(o); }); sel.value = 'rainbow'; }
  $('#units').value = S.scene.units || 'in';
  if (!hadDevices || S.scene.devices.length !== hadDevices) fitPending = true;
  renderHead(); renderDevices(); renderPerSet(); draw();
}

function renderHead() {
  const n = S.scene.devices.length, leds = S.scene.devices.reduce((a, d) => a + d.layout.length, 0);
  $('#summary').textContent = n ? `${n} set${n > 1 ? 's' : ''} · ${leds} LEDs` : 'no sets yet';
  $('#liveTag').hidden = !S.live;
  $('#liveTag').textContent = S.live ? `LIVE · ${S.live.pattern === 'media' ? S.live.source : S.live.pattern}` : '';
  $('#liveTag').title = S.live ? 'The dots show exactly what is being sent to the strings' : '';
  $('#btnLive').classList.toggle('live', !!S.live);
  $('#btnLive').textContent = S.live ? 'Live' : 'Go live';
}

function fmt(v) { return Math.round(v * 10) / 10; }
function renderDevices() {
  const u = S.scene.units || 'in';
  $('#devCards').innerHTML = S.scene.devices.map((d) => `
    <div class="card ${S.sel === d.id ? 'sel' : ''}" data-id="${d.id}">
      <div class="name">${d.name} <span class="meta">${d.ip}${d.online === false ? ' · offline' : ''}</span></div>
      <div class="meta">${d.product || ''} · fw ${d.firmware || '?'} · ${d.layout.length} LEDs · max ${d.frameRate || '?'} fps · map: ${d.layoutSource === 'linear' ? 'none (straight line)' : d.layoutSource || '?'}</div>
      <div class="fields">
        <label>x (${u})<input type="number" step="1" data-f="x" value="${fmt(d.place.x)}"></label>
        <label>y (${u})<input type="number" step="1" data-f="y" value="${fmt(d.place.y)}"></label>
        <label>width<input type="number" step="1" data-f="w" value="${fmt(d.place.w)}"></label>
        <label>height<input type="number" step="1" data-f="h" value="${fmt(d.place.h)}"></label>
        <label>rotation<input type="number" step="1" data-f="rot" value="${fmt(d.place.rot)}"></label>
      </div>
      <div class="actions">
        <button data-act="push" ${S.dirty[d.id] ? '' : 'disabled'}>Push LED layout</button>
        <button data-act="revert" ${S.dirty[d.id] ? '' : 'disabled'}>Revert LEDs</button>
        <button data-act="refresh">Reconnect</button>
        <button data-act="remove" class="danger">Remove</button>
      </div>
      ${S.scene.devices.some((o) => o.id !== d.id && o.layout.length === d.layout.length && o.layoutSource !== 'linear') ? `<div class="actions"><select data-copy>${S.scene.devices.filter((o) => o.id !== d.id && o.layout.length === d.layout.length && o.layoutSource !== 'linear').map((o) => `<option value="${o.id}">${o.name}</option>`).join('')}</select><button data-act="copy">Copy that set's map onto this one</button></div>` : ''}
    </div>`).join('');
  $$('#devCards .card').forEach((card) => {
    const id = card.dataset.id;
    const d = S.scene.devices.find((x) => x.id === id);
    card.onclick = (e) => { if (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON') return; S.sel = id; $$('#devCards .card').forEach((c) => c.classList.toggle('sel', c === card)); draw(); };
    card.querySelectorAll('input[data-f]').forEach((inp) => (inp.onchange = async () => { d.place[inp.dataset.f] = Number(inp.value); await safe(window.api.setPlace({ id, place: d.place })); fitPending = true; draw(); }));
    card.querySelector('[data-act=push]').onclick = async () => {
      const r = await safe(window.api.pushLayout({ id, coordinates: d.layout }));
      if (r) { delete S.dirty[id]; status(`Layout saved on ${d.name}. Backup written to the app data folder.`); loadScene(); }
    };
    card.querySelector('[data-act=revert]').onclick = () => { d.layout = S.dirty[id].map((c) => ({ ...c })); delete S.dirty[id]; renderDevices(); draw(); };
    card.querySelector('[data-act=refresh]').onclick = async () => { status(`Reconnecting ${d.name}...`); await safe(window.api.refreshDevice({ id }), `Reconnected ${d.name}`); loadScene(); };
    const copyBtn = card.querySelector('[data-act=copy]');
    if (copyBtn) copyBtn.onclick = async () => {
      const src = S.scene.devices.find((o) => o.id === card.querySelector('[data-copy]').value);
      if (!src) return;
      status(`Copying the map from ${src.name} onto ${d.name}...`);
      const r = await safe(window.api.pushLayout({ id, coordinates: src.layout, source: src.layoutSource || '2d' }));
      if (r) { delete S.dirty[id]; status(`${d.name} now uses the map from ${src.name}. It is only right if both sets hang the same way.`); loadScene(); }
    };
    card.querySelector('[data-act=remove]').onclick = async () => { await safe(window.api.removeDevice({ id }), `Removed ${d.name}`); S.sel = null; fitPending = true; loadScene(); };
  });
}

function renderPerSet() {
  $('#perSet').innerHTML = S.scene.devices.map((d) => {
    const st = S.status[d.id] || {};
    return `<div class="card" data-id="${d.id}"><div class="name">${d.name} <span class="meta">${st.error ? st.error : `mode ${st.mode || '?'} · brightness ${st.brightness == null ? '?' : st.brightness}`}</span></div>
      <div class="actions seg"><button data-m="on">On</button><button data-m="off">Off</button><button data-m="effect">Effect</button><button data-m="movie">Movie</button></div></div>`;
  }).join('');
  $$('#perSet .card').forEach((card) => card.querySelectorAll('button[data-m]').forEach((b) => (b.onclick = () => safe(window.api.setMode({ mode: b.dataset.m, id: card.dataset.id })).then((r) => { perSetResult(r, `Mode ${b.dataset.m} applied`); poll(); }))));
}

async function poll() {
  if (!S.scene.devices.length) return;
  const r = await safe(window.api.status());
  if (!r) return;
  S.status = r.devices; S.live = r.live;
  const modes = new Set(Object.values(r.devices).map((s) => s.mode).filter(Boolean));
  $$('#modeSeg button').forEach((b) => b.classList.toggle('on', modes.size === 1 && modes.has(b.dataset.mode)));
  const first = Object.values(r.devices).find((s) => s.brightness != null);
  if (first && document.activeElement !== $('#bri')) { $('#bri').value = first.brightness; $('#briVal').textContent = first.brightness; }
  $('#nextTag').textContent = r.next ? `next: ${r.next.action}${r.next.preset ? ' ' + r.next.preset : ''} at ${new Date(r.next.at).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}` : '';
  $('#schedNext').textContent = $('#nextTag').textContent;
  if (!S.live) S.frames = {};
  renderHead(); renderPerSet(); draw();
}

$$('#tabs button').forEach((b) => (b.onclick = () => {
  $$('#tabs button').forEach((x) => x.classList.toggle('on', x === b));
  $$('section[data-panel]').forEach((s) => (s.hidden = s.dataset.panel !== b.dataset.tab));
  if (b.dataset.tab === 'presets') renderPresets();
  if (b.dataset.tab === 'schedule') renderSchedule();
  if (b.dataset.tab === 'settings') loadSettings();
}));

$$('#modeSeg button').forEach((b) => (b.onclick = () => safe(window.api.setMode({ mode: b.dataset.mode })).then((r) => { perSetResult(r, `Mode ${b.dataset.mode} applied to all sets`); poll(); })));
$('#bri').oninput = () => ($('#briVal').textContent = $('#bri').value);
$('#bri').onchange = () => safe(window.api.setBrightness({ value: +$('#bri').value })).then((r) => perSetResult(r, `Brightness ${$('#bri').value}`));
$('#btnSolid').onclick = () => { const h = $('#solid').value; safe(window.api.setColor({ r: parseInt(h.substr(1, 2), 16), g: parseInt(h.substr(3, 2), 16), b: parseInt(h.substr(5, 2), 16) })).then((r) => { perSetResult(r, 'Solid colour applied'); poll(); }); };
$('#fxPrev').onclick = () => setFx(-1);
$('#fxNext').onclick = () => setFx(1);
async function setFx(d) { const n = Math.max(1, ...S.scene.devices.map((x) => x.effectsNumber || 1)); S.fx = (((S.fx + d) % n) + n) % n; const r = await safe(window.api.setEffect({ effectId: S.fx })); perSetResult(r, `Effect ${S.fx + 1}`); $('#fxLabel').textContent = `effect ${S.fx + 1} of ${n}`; poll(); }

function params() { return { color1: $('#c1').value, color2: $('#c2').value, speed: +$('#speed').value, scale: +$('#scale').value, angle: +$('#angle').value, density: +$('#density').value }; }
let pushT = 0;
function pushPattern() { if (!S.live) return; clearTimeout(pushT); pushT = setTimeout(() => safe(window.api.liveStart({ pattern: $('#pat').value, params: params(), fps: 30 })), 80); }
['speed', 'scale', 'angle', 'density'].forEach((id) => { const el = $('#' + id); el.oninput = () => { $('#' + id + 'Val').textContent = id === 'angle' ? el.value : (+el.value).toFixed(2); pushPattern(); }; });
$('#c1').oninput = $('#c2').oninput = pushPattern;
$('#pat').onchange = pushPattern;
$('#btnLive').onclick = async () => { await safe(window.api.liveStart({ pattern: $('#pat').value, params: params(), fps: 30 })); poll(); };
$('#btnStopLive').onclick = async () => { await safe(window.api.liveStop({})); S.frames = {}; poll(); };

$('#btnSavePreset').onclick = async () => {
  const name = $('#presetName').value.trim(); if (!name) return status('Give the preset a name first');
  S.presets = await safe(window.api.savePreset({ name, preset: { pattern: $('#pat').value, params: params(), fps: 30, brightness: +$('#bri').value, movieSeconds: +$('#mvSec').value } }), `Saved preset "${name}"`) || S.presets;
};
$('#btnSaveMovie').onclick = async () => {
  status('Rendering and uploading to every set...');
  const r = await safe(window.api.saveMovie({ title: $('#mvTitle').value, seconds: +$('#mvSec').value, pattern: $('#pat').value, params: params() }));
  if (r) { const lines = S.scene.devices.map((d) => { const x = r[d.id] || {}; return `${d.name}: ${x.error ? x.error : `${x.frames} frames at ${x.fps} fps`}`; }); status(lines.join(' · ')); $('#mvInfo').textContent = lines.join('\n'); }
  poll();
};
$('#btnDelMovies').onclick = async () => { await safe(window.api.deleteMovies(), 'Stored movies deleted on all sets'); poll(); };

async function renderPresets() {
  S.presets = await window.api.listPresets();
  const names = Object.keys(S.presets);
  $('#presetList').innerHTML = names.length ? names.map((n) => { const p = S.presets[n]; const meta = p.type === 'media' ? `media · ${p.source} · ${p.count} frames · brightness ${p.brightness}` : `${p.pattern} · speed ${p.params.speed} · brightness ${p.brightness}`; return `<div class="card" data-n="${n}"><div class="name">${n}</div><div class="meta">${meta}</div><div class="actions"><button data-a="apply" class="primary">Apply live</button>${p.type === 'media' ? '' : '<button data-a="load">Load into Live tab</button>'}<button data-a="del" class="danger">Delete</button></div></div>`; }).join('') : '<p class="dim">No presets saved yet.</p>';
  $$('#presetList .card').forEach((card) => {
    const n = card.dataset.n, p = S.presets[n];
    card.querySelector('[data-a=apply]').onclick = () => safe(window.api.applyPreset({ name: n }), `Live with "${n}"`).then(poll);
    const loadBtn = card.querySelector('[data-a=load]');
    if (loadBtn) loadBtn.onclick = () => { $('#pat').value = p.pattern; $('#c1').value = p.params.color1; $('#c2').value = p.params.color2; for (const k of ['speed', 'scale', 'angle', 'density']) { $('#' + k).value = p.params[k]; $('#' + k + 'Val').textContent = k === 'angle' ? p.params[k] : (+p.params[k]).toFixed(2); } $('#presetName').value = n; $$('#tabs button')[1].click(); };
    card.querySelector('[data-a=del]').onclick = async () => { S.presets = await window.api.deletePreset({ name: n }); renderPresets(); };
  });
}

const DAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
async function renderSchedule(keepLocal) {
  if (!keepLocal) S.schedule = await window.api.getSchedule();
  S.presets = await window.api.listPresets();
  const presetOpts = (sel) => Object.keys(S.presets).map((n) => `<option ${n === sel ? 'selected' : ''}>${n}</option>`).join('') || '<option value="">(save a preset first)</option>';
  $('#schedList').innerHTML = S.schedule.length ? S.schedule.map((e, i) => `
    <div class="card ${e.enabled ? '' : 'off'}" data-i="${i}">
      <div class="row"><label class="chk"><input type="checkbox" data-f="enabled" ${e.enabled ? 'checked' : ''}></label><input type="time" data-f="time" value="${e.time || '17:30'}">
        <select data-f="action"><option value="live" ${e.action === 'live' ? 'selected' : ''}>Go live with preset</option><option value="preset-movie" ${e.action === 'preset-movie' ? 'selected' : ''}>Upload preset as movie</option><option value="effect" ${e.action === 'effect' ? 'selected' : ''}>Built-in effect</option><option value="movie" ${e.action === 'movie' ? 'selected' : ''}>Stored movie</option><option value="off" ${e.action === 'off' ? 'selected' : ''}>Off</option></select></div>
      <div class="row"><select data-f="preset" ${e.action === 'live' || e.action === 'preset-movie' ? '' : 'disabled'}>${presetOpts(e.preset)}</select>
        <div class="days">${DAYS.map((d, k) => `<button data-day="${k}" class="${!e.days || !e.days.length || e.days.includes(k) ? 'on' : ''}">${d}</button>`).join('')}</div>
        <button data-a="del" class="danger">✕</button></div>
    </div>`).join('') : '<p class="dim">No entries. Add one, for example 5:30 pm go live with a preset and 11:00 pm off.</p>';
  $$('#schedList .card').forEach((card) => {
    const e = S.schedule[+card.dataset.i];
    if (!e.days || !e.days.length) e.days = [0, 1, 2, 3, 4, 5, 6];
    card.querySelectorAll('[data-f]').forEach((inp) => (inp.onchange = () => { e[inp.dataset.f] = inp.type === 'checkbox' ? inp.checked : inp.value; if (inp.dataset.f === 'action') renderSchedule(true); }));
    card.querySelectorAll('[data-day]').forEach((b) => (b.onclick = () => { const k = +b.dataset.day; e.days = e.days.includes(k) ? e.days.filter((x) => x !== k) : [...e.days, k].sort(); b.classList.toggle('on'); }));
    card.querySelector('[data-a=del]').onclick = () => { S.schedule.splice(+card.dataset.i, 1); renderSchedule(true); };
  });
}
$('#btnAddSched').onclick = () => { S.schedule.push({ enabled: true, time: '17:30', action: 'live', preset: Object.keys(S.presets)[0] || '', days: [0, 1, 2, 3, 4, 5, 6] }); renderSchedule(true); };
$('#btnSaveSched').onclick = async () => { S.schedule = await safe(window.api.setSchedule({ entries: S.schedule }), 'Schedule saved') || S.schedule; renderSchedule(); poll(); };

async function loadSettings() {
  const s = await window.api.getSettings();
  $('#keepRunning').checked = !!s.keepRunning; $('#openAtLogin').checked = !!s.openAtLogin; $('#startMinimized').checked = !!s.startMinimized;
  $('#streamHz').value = String(s.streamHz || 20);
  $('#log').textContent = (await window.api.getLog()).join('\n');
}
['keepRunning', 'openAtLogin', 'startMinimized'].forEach((k) => ($('#' + k).onchange = () => safe(window.api.setSettings({ [k]: $('#' + k).checked }))));
$('#streamHz').onchange = () => safe(window.api.setSettings({ streamHz: +$('#streamHz').value }), `Now sending ${$('#streamHz').value} frames per second`);

$('#btnScan').onclick = async () => {
  status('Scanning for Twinkly sets...');
  const d = await safe(window.api.discover()); if (!d) return;
  const sel = $('#devList'); sel.innerHTML = '';
  Object.entries(d).forEach(([ip, name]) => { const o = document.createElement('option'); o.value = ip; o.textContent = `${name} (${ip})`; sel.appendChild(o); });
  status(Object.keys(d).length ? `Found ${Object.keys(d).length} set(s)` : 'No sets answered the broadcast. Type the IP instead.');
};
$('#btnAdd').onclick = async () => {
  const ip = $('#devIp').value.trim() || $('#devList').value; if (!ip) return status('Pick a scanned set or type an IP');
  status(`Connecting to ${ip}...`);
  const r = await safe(window.api.addDevice({ ip })); if (r) { status(`Added ${r.name} with ${r.leds} LEDs`); $('#devIp').value = ''; fitPending = true; loadScene(); }
};
$('#units').onchange = () => safe(window.api.setUnits({ units: $('#units').value })).then(loadScene);

window.api.onFrame((data) => {
  let idx = null;
  if (data) { idx = data._idx == null ? null : data._idx; S.frames = {}; for (const id in data) if (id !== '_idx') S.frames[id] = data[id]; }
  else S.frames = {};
  draw();
  if (typeof onLiveFrame === 'function') onLiveFrame(idx);
});
window.api.onChanged((what) => { if (what === 'scene') loadScene(); else poll(); });

resize();
loadScene().then(poll);
setInterval(() => { if (!S.drag) poll(); }, 4000);
