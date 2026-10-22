const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { discover, Xled } = require('./xled');
const { Engine } = require('./engine');
const { Store } = require('./store');
const { Scheduler } = require('./scheduler');
const { defaultPlace } = require('./scene');
const patterns = require('./patterns');

let win = null;
let tray = null;
let quitting = false;
const clients = new Map();
const log = [];
const store = new Store(app.getPath('userData'));
const scene = () => store.data.scene;
const engine = new Engine(scene, (id) => clients.get(id));
let scheduler = null;
let lastModes = {};
let statusCache = {};
let currentLive = null;

function addLog(msg) {
  log.push(`${new Date().toLocaleTimeString()}  ${msg}`);
  if (log.length > 200) log.shift();
}

function send(channel, data) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, data);
}

function bump() {
  scene().version = (scene().version || 0) + 1;
  engine.invalidate();
  store.save();
  send('changed', 'scene');
}

function device(id) {
  const d = scene().devices.find((x) => x.id === id);
  if (!d) throw new Error('unknown device');
  return d;
}

function client(id) {
  const c = clients.get(id);
  if (!c) throw new Error('device not connected');
  return c;
}

async function connectDevice(d) {
  const c = new Xled(d.ip);
  c.onRelogin = () => addLog(`re-authenticated with ${d.name}: something else had logged in (the Twinkly phone app?)`);
  await c.login();
  const g = await c.gestalt();
  const layout = await c.layout();
  const fx = await c.effects();
  d.name = g.device_name || d.name;
  d.product = g.product_code;
  d.firmware = await c.firmware();
  d.leds = g.number_of_led;
  d.bytesPerLed = g.bytes_per_led || 3;
  d.frameRate = g.frame_rate || 13;
  d.movieCapacity = g.movie_capacity;
  d.effectsNumber = fx.effects_number || 0;
  d.layoutSource = layout.source || '2d';
  d.layout = (layout.coordinates || []).map((c) => ({ x: c.x, y: c.y, z: c.z == null ? 0 : c.z }));
  d.online = true;
  const old = clients.get(d.id);
  if (old) old.close();
  clients.set(d.id, c);
  return c;
}

async function connectAll() {
  for (const d of scene().devices) {
    try { await connectDevice(d); addLog(`connected ${d.name} at ${d.ip}`); }
    catch (e) { d.online = false; addLog(`could not connect ${d.ip}: ${e.message}`); }
  }
  bump();
}

function targets(id) {
  return id ? [device(id)] : scene().devices;
}

async function forEachDevice(id, fn) {
  const out = {};
  for (const d of targets(id)) {
    const c = clients.get(d.id);
    if (!c) { out[d.id] = { error: 'offline' }; continue; }
    try { out[d.id] = await fn(c, d); } catch (e) { out[d.id] = { error: e.message }; }
  }
  return out;
}

async function stopLive(mode) {
  if (!engine.running) return;
  engine.stop();
  currentLive = null;
  await forEachDevice(null, (c, d) => c.setMode(mode || lastModes[d.id] || 'effect'));
  send('changed', 'live');
}

function startLive(pattern, params, fps) {
  fps = fps || 30;
  currentLive = { pattern, params: Object.assign({}, params), fps };
  engine.set(pattern, params, fps);
  send('changed', 'live');
}

function clipFromIpc(clip) {
  const devices = {};
  for (const id in clip.devices) devices[id] = Buffer.from(clip.devices[id]);
  return { fps: Math.max(1, Math.round(clip.fps || 13)), count: Math.max(1, Math.round(clip.count || 1)), devices };
}

function startClip(clip, source) {
  currentLive = { pattern: 'media', source, fps: clip.fps };
  engine.setClip(clip);
  send('changed', 'live');
}

function mediaDir() {
  const dir = path.join(app.getPath('userData'), 'media');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeClipFile(name, clip, source) {
  const safe = name.replace(/[^a-z0-9_-]+/gi, '_').slice(0, 40);
  const file = path.join(mediaDir(), `${safe}_${crypto.randomUUID().slice(0, 8)}.json`);
  const devices = {};
  for (const id in clip.devices) devices[id] = clip.devices[id].toString('base64');
  fs.writeFileSync(file, JSON.stringify({ fps: clip.fps, count: clip.count, source, devices }), 'utf8');
  return file;
}

function readClipFile(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const devices = {};
  for (const id in raw.devices) devices[id] = Buffer.from(raw.devices[id], 'base64');
  return { fps: raw.fps, count: raw.count, devices, source: raw.source };
}

async function applyPreset(name) {
  const p = store.data.presets[name];
  if (!p) throw new Error(`preset ${name} missing`);
  if (p.brightness != null) await forEachDevice(null, (c) => c.setBrightness(p.brightness));
  if (p.type === 'media') startClip(readClipFile(p.file), p.source || name);
  else startLive(p.pattern, p.params, p.fps);
  return p;
}

async function runScheduled(e) {
  if (e.action === 'live') {
    await applyPreset(e.preset);
  } else if (e.action === 'off' || e.action === 'effect' || e.action === 'movie') {
    await stopLive(e.action);
    await forEachDevice(null, (c) => c.setMode(e.action));
  } else if (e.action === 'preset-movie') {
    const p = store.data.presets[e.preset];
    if (!p) throw new Error(`preset ${e.preset} missing`);
    if (p.type === 'media') await uploadClip(e.preset, readClipFile(p.file));
    else await saveMovie({ title: e.preset, seconds: p.movieSeconds || 20, pattern: p.pattern, params: p.params });
  }
}

async function uploadRendered(title, rendered, fps) {
  const results = {};
  if (engine.running) { engine.stop(); currentLive = null; send('changed', 'live'); }
  for (const d of scene().devices) {
    const c = clients.get(d.id);
    const r = rendered[d.id];
    if (!c || !r) { results[d.id] = { error: 'offline' }; continue; }
    try {
      const mv = await c.movies();
      if (r.frames > (mv.available_frames || 0)) throw new Error(`${r.frames} frames needed, ${mv.available_frames} free`);
      await c.setMode('off');
      const meta = await c.uploadMovie(title, r.buffer, r.count, fps, d.bytesPerLed);
      await c.setCurrentMovie(meta.id);
      await c.setMode('movie');
      results[d.id] = { id: meta.id, frames: r.frames, fps };
      addLog(`movie "${title}" uploaded to ${d.name}: ${r.frames} frames`);
    } catch (e) {
      results[d.id] = { error: e.message };
      addLog(`movie upload to ${d.name} failed: ${e.message}`);
    }
  }
  return results;
}

function deviceFpsCeiling() {
  return Math.max(1, Math.min(...scene().devices.map((d) => Math.floor(d.frameRate || 13)), 20));
}

async function saveMovie({ title, seconds, pattern, params }) {
  const fpsAll = deviceFpsCeiling();
  const rendered = engine.renderMovie(pattern, params, seconds, fpsAll);
  return uploadRendered(title, rendered, fpsAll);
}

async function uploadClip(title, clip) {
  const rendered = {};
  for (const d of scene().devices) {
    const buf = clip.devices[d.id];
    if (buf) rendered[d.id] = { buffer: buf, count: d.layout.length, frames: clip.count };
  }
  return uploadRendered(title, rendered, Math.min(clip.fps, deviceFpsCeiling()));
}

function registerIpc() {
  ipcMain.handle('devices:discover', () => discover());

  ipcMain.handle('devices:add', async (_e, { ip }) => {
    if (scene().devices.some((d) => d.ip === ip)) throw new Error('that IP is already in the scene');
    const d = { id: crypto.randomUUID(), ip, name: ip, layout: [], place: defaultPlace(scene()) };
    await connectDevice(d);
    const aspect = 2;
    d.place.h = d.place.w / aspect;
    scene().devices.push(d);
    addLog(`added ${d.name} (${d.leds} LEDs)`);
    bump();
    return d;
  });

  ipcMain.handle('devices:remove', async (_e, { id }) => {
    await stopLive();
    const c = clients.get(id);
    if (c) c.close();
    clients.delete(id);
    scene().devices = scene().devices.filter((d) => d.id !== id);
    bump();
    return true;
  });

  ipcMain.handle('devices:refresh', async (_e, { id }) => {
    const d = device(id);
    await connectDevice(d);
    bump();
    return d;
  });

  ipcMain.handle('scene:get', () => ({ scene: scene(), live: currentLive, patterns: patterns.PATTERNS, defaults: patterns.DEFAULTS }));

  ipcMain.handle('scene:place', (_e, { id, place }) => {
    const d = device(id);
    d.place = Object.assign({}, d.place, place);
    d.place.w = Math.max(1, Number(d.place.w) || 1);
    d.place.h = Math.max(1, Number(d.place.h) || 1);
    bump();
    return d.place;
  });

  ipcMain.handle('scene:units', (_e, { units }) => { scene().units = units; store.save(); return units; });

  ipcMain.handle('scene:layout', async (_e, { id, coordinates, source }) => {
    const d = device(id);
    const c = client(id);
    if (coordinates.length !== d.layout.length) throw new Error(`that map has ${coordinates.length} LEDs but ${d.name} has ${d.layout.length}`);
    const backup = store.backup(`layout_${d.name}`, { source: d.layoutSource, coordinates: d.layout });
    const clean = coordinates.map((p) => ({ x: Number(p.x), y: Number(p.y), z: Number(p.z || 0) }));
    const res = await c.setLayout(clean, source || d.layoutSource || '2d');
    if (res.code !== 1000) throw new Error(`layout rejected: ${JSON.stringify(res)}`);
    const fresh = await c.layout();
    d.layoutSource = fresh.source || source || d.layoutSource;
    d.layout = (fresh.coordinates || []).map((p) => ({ x: p.x, y: p.y, z: p.z == null ? 0 : p.z }));
    addLog(`layout pushed to ${d.name}, backup ${path.basename(backup)}`);
    bump();
    return { backup };
  });

  ipcMain.handle('ctl:status', async () => {
    let out;
    if (engine.running) {
      out = {};
      for (const d of scene().devices) out[d.id] = clients.get(d.id) ? { mode: 'rt', brightness: (statusCache[d.id] || {}).brightness } : { error: 'offline' };
    } else {
      out = await forEachDevice(null, async (c, d) => {
        const mode = await c.mode();
        const bri = (await c.brightness()).value;
        if (mode !== 'off' && mode !== 'rt') lastModes[d.id] = mode;
        statusCache[d.id] = { mode, brightness: bri };
        return { mode, brightness: bri };
      });
    }
    return { devices: out, live: currentLive, next: scheduler ? scheduler.next() : null };
  });

  ipcMain.handle('ctl:mode', async (_e, { mode, id }) => {
    if (mode !== 'rt') await stopLive(mode === 'on' ? null : mode);
    return forEachDevice(id, async (c, d) => {
      const target = mode === 'on' ? lastModes[d.id] || 'effect' : mode;
      if (target === 'movie') {
        const mv = await c.movies();
        if (!mv.movies || !mv.movies.length) throw new Error('no movie stored on this set yet; upload one from the Live or Media tab');
      }
      return c.setMode(target);
    });
  });

  ipcMain.handle('ctl:brightness', (_e, { value, id }) => forEachDevice(id, (c, d) => { statusCache[d.id] = Object.assign({}, statusCache[d.id], { brightness: Math.round(value) }); return c.setBrightness(value); }));

  ipcMain.handle('ctl:color', async (_e, { r, g, b, id }) => {
    await stopLive('color');
    return forEachDevice(id, async (c) => { await c.setColor(r, g, b); return c.setMode('color'); });
  });

  ipcMain.handle('ctl:effect', async (_e, { effectId, id }) => {
    await stopLive('effect');
    return forEachDevice(id, async (c, d) => {
      const n = d.effectsNumber || 1;
      await c.setEffect(((effectId % n) + n) % n);
      return c.setMode('effect');
    });
  });

  ipcMain.handle('live:start', (_e, { pattern, params, fps }) => { startLive(pattern, params, fps); return true; });
  ipcMain.handle('live:stop', (_e, { mode } = {}) => stopLive(mode).then(() => true));

  ipcMain.handle('live:identify', (_e, { id, index }) => {
    let offset = 0;
    for (const d of scene().devices) { if (d.id === id) break; offset += d.layout.length; }
    currentLive = null;
    engine.set('identify', { index: offset + index }, 10);
    send('changed', 'live');
    return true;
  });

  ipcMain.handle('movie:save', (_e, body) => saveMovie(body));

  ipcMain.handle('movies:delete', async () => {
    await stopLive('off');
    return forEachDevice(null, async (c) => { await c.setMode('off'); const r = await c.deleteMovies(); await c.setMode('effect'); return r; });
  });

  ipcMain.handle('library:list', async () => {
    const perDevice = await forEachDevice(null, async (c) => {
      const mv = await c.movies();
      let current = null;
      try { current = (await c.get('movies/current')).id; } catch {}
      return { movies: mv.movies || [], available: mv.available_frames, capacity: mv.max_capacity, max: mv.max, current };
    });
    const byName = {};
    for (const d of scene().devices) {
      const r = perDevice[d.id];
      if (!r || r.error) continue;
      for (const m of r.movies) {
        if (!byName[m.name]) byName[m.name] = { name: m.name, frames: m.frames_number, fps: m.fps, sets: {} };
        byName[m.name].sets[d.id] = { id: m.id, current: r.current === m.id };
      }
    }
    return { perDevice, movies: Object.values(byName) };
  });

  ipcMain.handle('library:play', async (_e, { name }) => {
    await stopLive('movie');
    return forEachDevice(null, async (c) => {
      const mv = await c.movies();
      const m = (mv.movies || []).find((x) => x.name === name);
      if (!m) throw new Error(`"${name}" is not stored on this set`);
      await c.setCurrentMovie(m.id);
      return c.setMode('movie');
    });
  });

  ipcMain.handle('playlist:get', () => forEachDevice(null, (c) => c.playlist()));

  ipcMain.handle('playlist:play', async (_e, { entries }) => {
    await stopLive('playlist');
    return forEachDevice(null, async (c) => {
      const mv = await c.movies();
      const mapped = entries.map((e) => {
        const m = (mv.movies || []).find((x) => x.name === e.name);
        if (!m) throw new Error(`"${e.name}" is not stored on this set`);
        return { id: m.id, duration: e.seconds };
      });
      const r = await c.setPlaylist(mapped);
      if (r.code !== 1000) throw new Error(`playlist rejected: ${JSON.stringify(r)}`);
      return c.setMode('playlist');
    });
  });

  ipcMain.handle('playlist:stop', async () => forEachDevice(null, (c) => c.setMode('movie')));

  ipcMain.handle('presets:list', () => store.data.presets);
  ipcMain.handle('presets:save', (_e, { name, preset }) => { store.data.presets[name] = preset; store.save(); return store.data.presets; });
  ipcMain.handle('presets:delete', (_e, { name }) => {
    const p = store.data.presets[name];
    if (p && p.type === 'media' && p.file) { try { fs.unlinkSync(p.file); } catch {} }
    delete store.data.presets[name];
    store.save();
    return store.data.presets;
  });
  ipcMain.handle('presets:apply', (_e, { name }) => applyPreset(name));

  ipcMain.handle('media:play', (_e, { clip, source }) => { startClip(clipFromIpc(clip), source); return true; });
  ipcMain.handle('media:save', (_e, { title, clip }) => uploadClip(title, clipFromIpc(clip)));
  ipcMain.handle('media:preset', (_e, { name, clip, source, brightness }) => {
    const c = clipFromIpc(clip);
    const old = store.data.presets[name];
    if (old && old.type === 'media' && old.file) { try { fs.unlinkSync(old.file); } catch {} }
    const file = writeClipFile(name, c, source);
    store.data.presets[name] = { type: 'media', file, source, fps: c.fps, count: c.count, brightness };
    store.save();
    return store.data.presets;
  });

  ipcMain.handle('schedule:get', () => store.data.schedule);
  ipcMain.handle('schedule:set', (_e, { entries }) => {
    store.data.schedule = entries.map((e) => Object.assign({ id: crypto.randomUUID(), enabled: true, days: [] }, e));
    store.save();
    return store.data.schedule;
  });

  ipcMain.handle('settings:get', () => Object.assign({}, store.data.settings, { openAtLogin: app.getLoginItemSettings().openAtLogin }));
  ipcMain.handle('settings:set', (_e, s) => {
    Object.assign(store.data.settings, s);
    if ('openAtLogin' in s) app.setLoginItemSettings({ openAtLogin: !!s.openAtLogin, args: ['--minimized'] });
    if ('streamHz' in s) { engine.setRate(Number(s.streamHz)); addLog(`stream rate set to ${engine.sendHz} per second`); }
    store.save();
    return store.data.settings;
  });

  ipcMain.handle('app:log', () => log.slice(-60));
  ipcMain.handle('live:stats', () => engine.takeStats());
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0f1115',
    title: 'Twinkly Desk',
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
    show: !(store.data.settings.startMinimized || process.argv.includes('--minimized')),
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('close', (e) => {
    if (!quitting && store.data.settings.keepRunning) { e.preventDefault(); win.hide(); }
  });
}

function createTray() {
  const img = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'tray.png'));
  tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img);
  tray.setToolTip('Twinkly Desk');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Twinkly Desk', click: () => { if (win) { win.show(); win.focus(); } } },
    { label: 'Stop live pattern', click: () => stopLive() },
    { label: 'All lights off', click: () => stopLive('off').then(() => forEachDevice(null, (c) => c.setMode('off'))) },
    { type: 'separator' },
    { label: 'Quit', click: () => stopLive().catch(() => {}).then(() => { quitting = true; app.quit(); }) },
  ]));
  tray.on('click', () => { if (win) { win.show(); win.focus(); } });
}

app.whenReady().then(async () => {
  registerIpc();
  engine.setRate(store.data.settings.streamHz);
  engine.on('frame', (data) => send('frame', data));
  engine.on('watchdog', ({ id, mode }) => { const d = scene().devices.find((x) => x.id === id); addLog(`${d ? d.name : id} had left live mode (was ${mode}); put it back`); });
  createWindow();
  createTray();
  scheduler = new Scheduler(() => store.data.schedule, runScheduled, addLog);
  connectAll();
});

app.on('before-quit', (e) => {
  if (engine.running) {
    e.preventDefault();
    stopLive().catch(() => {}).then(() => { quitting = true; app.quit(); });
    return;
  }
  quitting = true;
  store.flush();
  for (const c of clients.values()) c.close();
});

app.on('window-all-closed', () => {
  if (!store.data.settings.keepRunning) app.quit();
});

app.on('activate', () => { if (win) win.show(); });
