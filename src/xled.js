const http = require('http');
const dgram = require('dgram');
const crypto = require('crypto');

const DISCOVER_PORT = 5555;
const RT_PORT = 7777;
const TOKEN_LIFETIME_MS = 14000 * 1000;

function discover(timeoutMs = 3000) {
  return new Promise((resolve) => {
    const found = {};
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    sock.on('message', (msg, rinfo) => {
      if (msg.length >= 6 && msg.toString('ascii', 4, 6) === 'OK') {
        const rest = msg.subarray(6);
        const end = rest.indexOf(0);
        found[rinfo.address] = rest.subarray(0, end < 0 ? rest.length : end).toString('ascii');
      }
    });
    sock.on('error', () => {});
    sock.bind(0, () => {
      sock.setBroadcast(true);
      const payload = Buffer.from('\x01discover', 'binary');
      const send = () => sock.send(payload, DISCOVER_PORT, '255.255.255.255', () => {});
      send();
      const iv = setInterval(send, 700);
      setTimeout(() => { clearInterval(iv); sock.close(); resolve(found); }, timeoutMs);
    });
  });
}

class Xled {
  constructor(ip) {
    this.ip = ip;
    this.token = null;
    this.tokenBytes = null;
    this.tokenTime = 0;
    this.udp = dgram.createSocket('udp4');
    this.udp.on('error', () => {});
    this.loginPromise = null;
    this.logins = 0;
    this.onRelogin = null;
  }

  raw(method, path, body, contentType) {
    return new Promise((resolve, reject) => {
      const headers = { Connection: 'close' };
      if (this.token) headers['X-Auth-Token'] = this.token;
      if (body !== undefined) {
        headers['Content-Type'] = contentType || 'application/json';
        headers['Content-Length'] = Buffer.byteLength(body);
      }
      const req = http.request(
        { host: this.ip, port: 80, path: `/xled/v1/${path}`, method, headers, agent: false, timeout: 8000 },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let json = {};
            if (text) { try { json = JSON.parse(text); } catch { json = { raw: text }; } }
            if (json === null || typeof json !== 'object' || Array.isArray(json)) json = { value: json };
            json._http = res.statusCode;
            resolve(json);
          });
        }
      );
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', reject);
      if (body !== undefined) req.write(body);
      req.end();
    });
  }

  async login() {
    if (this.loginPromise) return this.loginPromise;
    this.loginPromise = (async () => {
      this.token = null;
      const challenge = crypto.randomBytes(32).toString('base64');
      const r = await this.raw('POST', 'login', JSON.stringify({ challenge }));
      if (!r.authentication_token) throw new Error(`login failed: ${JSON.stringify(r)}`);
      this.token = r.authentication_token;
      this.tokenBytes = Buffer.from(this.token, 'base64');
      const v = await this.raw('POST', 'verify', JSON.stringify({ 'challenge-response': r['challenge-response'] }));
      if (v.code !== 1000) throw new Error(`verify failed: ${JSON.stringify(v)}`);
      this.tokenTime = Date.now();
      this.logins++;
      if (this.logins > 1 && this.onRelogin) this.onRelogin();
    })();
    try { await this.loginPromise; } finally { this.loginPromise = null; }
  }

  async ensure() {
    if (!this.token || Date.now() - this.tokenTime > TOKEN_LIFETIME_MS) await this.login();
  }

  async req(method, path, body, contentType) {
    await this.ensure();
    let last = null;
    for (let i = 0; i < 3; i++) {
      try {
        const r = await this.raw(method, path, body, contentType);
        if (r._http === 401) { await this.login(); continue; }
        return r;
      } catch (e) {
        last = e;
        await new Promise((res) => setTimeout(res, 300));
      }
    }
    throw new Error(`${method} ${path} failed: ${last && last.message}`);
  }

  get(path) { return this.req('GET', path); }
  post(path, obj) { return this.req('POST', path, JSON.stringify(obj)); }
  postRaw(path, buf) { return this.req('POST', path, buf, 'application/octet-stream'); }
  del(path) { return this.req('DELETE', path); }

  gestalt() { return this.get('gestalt'); }
  async firmware() { return (await this.get('fw/version')).version; }
  config() { return this.get('led/config'); }
  layout() { return this.get('led/layout/full'); }
  setLayout(coordinates, source = '2d') { return this.post('led/layout/full', { source, synthesized: false, coordinates }); }
  async mode() { return (await this.get('led/mode')).mode; }
  setMode(mode) { return this.post('led/mode', { mode }); }
  brightness() { return this.get('led/out/brightness'); }
  setBrightness(value) { return this.post('led/out/brightness', { mode: 'enabled', type: 'A', value: Math.round(value) }); }
  setColor(r, g, b) { return this.post('led/color', { red: Math.round(r), green: Math.round(g), blue: Math.round(b) }); }
  effects() { return this.get('led/effects'); }
  currentEffect() { return this.get('led/effects/current'); }
  setEffect(id) { return this.post('led/effects/current', { effect_id: Math.round(id) }); }
  movies() { return this.get('movies'); }
  setCurrentMovie(id) { return this.post('movies/current', { id: Math.round(id) }); }
  deleteMovies() { return this.del('movies'); }
  playlist() { return this.get('playlist'); }
  setPlaylist(entries) { return this.post('playlist', { entries: entries.map((e) => ({ id: Math.round(e.id), duration: Math.round(e.duration) })) }); }
  deletePlaylist() { return this.del('playlist'); }
  timer() { return this.get('timer'); }
  setTimer(timeOn, timeOff) {
    const d = new Date();
    const now = d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();
    return this.post('timer', { time_now: now, time_on: Math.round(timeOn), time_off: Math.round(timeOff) });
  }

  async uploadMovie(name, frames, ledsPerFrame, fps, bytesPerLed = 3) {
    const framesNumber = Math.floor(frames.length / (ledsPerFrame * bytesPerLed));
    const meta = await this.post('movies/new', {
      name: String(name).slice(0, 31),
      unique_id: crypto.randomUUID().toUpperCase(),
      descriptor_type: bytesPerLed === 3 ? 'rgb_raw' : 'rgbw_raw',
      leds_per_frame: ledsPerFrame,
      frames_number: framesNumber,
      fps: Math.round(fps),
    });
    if (meta.code !== 1000) throw new Error(`movies/new rejected: ${JSON.stringify(meta)}`);
    const full = await this.postRaw('movies/full', frames);
    if (full.code !== 1000) throw new Error(`movies/full rejected: ${JSON.stringify(full)}`);
    return meta;
  }

  sendFrame(frame) {
    if (!this.tokenBytes) return;
    for (let i = 0, n = 0; i < frame.length; i += 900, n++) {
      const chunk = frame.subarray(i, Math.min(i + 900, frame.length));
      const pkt = Buffer.concat([Buffer.from([3]), this.tokenBytes, Buffer.from([0, 0, n]), chunk]);
      this.udp.send(pkt, RT_PORT, this.ip, () => {});
    }
  }

  close() {
    try { this.udp.close(); } catch {}
  }
}

module.exports = { discover, Xled };
