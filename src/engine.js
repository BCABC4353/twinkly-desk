const { EventEmitter } = require('events');
const patterns = require('./patterns');
const { buildWorld } = require('./scene');

const WATCHDOG_MS = 5000;

class Engine extends EventEmitter {
  constructor(getScene, getClient) {
    super();
    this.getScene = getScene;
    this.getClient = getClient;
    this.name = null;
    this.params = {};
    this.fps = 20;
    this.timer = null;
    this.t0 = Date.now();
    this.world = null;
    this.worldVersion = -1;
    this.lastModePost = 0;
    this.lastEmit = 0;
    this.frames = {};
    this.clip = null;
    this.lastIdx = -1;
    this.lastTick = 0;
    this.sendHz = 20;
    this.stats = { ticks: 0, maxGap: 0, over60: 0, since: Date.now() };
  }

  setRate(hz) {
    this.sendHz = Math.max(5, Math.min(40, Math.round(hz || 20)));
    if (this.timer) this.restart();
  }

  tickHz() {
    return this.clip ? this.clip.fps : this.sendHz;
  }

  takeStats() {
    const s = Object.assign({}, this.stats, { seconds: (Date.now() - this.stats.since) / 1000, running: this.running });
    this.stats = { ticks: 0, maxGap: 0, over60: 0, since: Date.now() };
    return s;
  }

  get running() { return this.timer !== null; }

  invalidate() { this.worldVersion = -1; }

  set(name, params, fps) {
    this.clip = null;
    this.name = name;
    this.params = Object.assign({}, params || {});
    this.fps = Math.max(1, Math.min(40, Math.round(fps || 20)));
    this.restart();
  }

  setClip(clip) {
    this.clip = clip;
    this.name = 'clip';
    this.params = {};
    this.fps = Math.max(1, Math.min(40, Math.round(clip.fps || 13)));
    this.t0 = Date.now();
    this.lastIdx = -1;
    this.restart();
  }

  restart() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.timer = setInterval(() => this.tick(), 1000 / this.tickHz());
    this.postMode(true);
  }

  async postMode(force) {
    const now = Date.now();
    if (!force && now - this.lastModePost < WATCHDOG_MS) return;
    this.lastModePost = now;
    for (const seg of (this.world ? this.world.segs : this.getScene().devices.map((d) => ({ id: d.id })))) {
      const c = this.getClient(seg.id);
      if (!c) continue;
      if (force) { c.setMode('rt').catch(() => {}); continue; }
      c.mode().then((m) => {
        if (m !== 'rt' && this.running) { this.emit('watchdog', { id: seg.id, mode: m }); c.setMode('rt').catch(() => {}); }
      }).catch(() => {});
    }
  }

  tick() {
    const scene = this.getScene();
    if (this.worldVersion !== scene.version) {
      this.world = buildWorld(scene);
      this.worldVersion = scene.version;
    }
    if (!this.world.total) return;
    const nowMs = Date.now();
    if (this.lastTick) {
      const gap = nowMs - this.lastTick;
      this.stats.ticks++;
      if (gap > this.stats.maxGap) this.stats.maxGap = gap;
      if (gap > 60) this.stats.over60++;
    }
    this.lastTick = nowMs;
    const t = (nowMs - this.t0) / 1000;
    let idx = null;
    if (this.clip) {
      idx = Math.round(t * this.clip.fps) % Math.max(1, this.clip.count);
      if (idx === this.lastIdx) { this.postMode(false); return; }
      this.lastIdx = idx;
      for (const seg of this.world.segs) {
        const buf = this.clip.devices[seg.id];
        const len = seg.count * 3;
        if (!buf || buf.length < (idx + 1) * len) continue;
        const slice = buf.subarray(idx * len, (idx + 1) * len);
        this.frames[seg.id] = slice;
        const c = this.getClient(seg.id);
        if (c) c.sendFrame(slice);
      }
    } else {
      const frame = patterns.render(this.name, this.world.pts, t, this.params);
      for (const seg of this.world.segs) {
        const slice = frame.subarray(seg.start * 3, (seg.start + seg.count) * 3);
        this.frames[seg.id] = slice;
        const c = this.getClient(seg.id);
        if (c) c.sendFrame(slice);
      }
    }
    this.postMode(false);
    const now = Date.now();
    if (now - this.lastEmit > 25) {
      this.lastEmit = now;
      const out = {};
      for (const seg of this.world.segs) if (this.frames[seg.id]) out[seg.id] = Array.from(this.frames[seg.id]);
      if (idx !== null) out._idx = idx;
      this.emit('frame', out);
    }
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.name = null;
    this.clip = null;
    this.frames = {};
    this.lastTick = 0;
    this.emit('frame', null);
  }

  renderMovie(name, params, seconds, fps) {
    const scene = this.getScene();
    const world = buildWorld(scene);
    const n = Math.max(1, Math.floor(seconds * fps));
    const perDevice = {};
    for (const seg of world.segs) perDevice[seg.id] = [];
    for (let i = 0; i < n; i++) {
      const frame = patterns.render(name, world.pts, i / fps, params);
      for (const seg of world.segs) perDevice[seg.id].push(Buffer.from(frame.subarray(seg.start * 3, (seg.start + seg.count) * 3)));
    }
    const out = {};
    for (const seg of world.segs) out[seg.id] = { buffer: Buffer.concat(perDevice[seg.id]), count: seg.count, frames: n };
    return out;
  }
}

module.exports = { Engine };
