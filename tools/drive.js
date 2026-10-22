const fs = require('fs');
const path = require('path');

const PORT = 9222;
const OUT = path.join(__dirname, '..', '..', 'shots');
fs.mkdirSync(OUT, { recursive: true });

async function target() {
  for (let i = 0; i < 30; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      const page = list.find((t) => t.type === 'page' && t.url.includes('index.html'));
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('no renderer target on the debug port');
}

async function connect() {
  const ws = new WebSocket(await target());
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
  };
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception ? r.exceptionDetails.exception.description : JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };
  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(OUT, name + '.png');
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    return file;
  };
  const setFile = async (selector, file) => {
    const doc = await send('DOM.getDocument', { depth: 1 });
    const node = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector });
    await send('DOM.setFileInputFiles', { nodeId: node.nodeId, files: [file] });
  };
  return { send, evaluate, shot, setFile, close: () => ws.close() };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const step = process.argv[2];
  const c = await connect();
  const log = (...a) => console.log(...a);
  try {
    if (step === 'status') {
      log(JSON.stringify(await c.evaluate('window.api.getScene()')));
      log(JSON.stringify(await c.evaluate('window.api.status()')));
      log(await c.shot('01_start'));
    }
    if (step === 'add') {
      const ip = process.argv[3];
      log(JSON.stringify(await c.evaluate('window.api.discover()')));
      log(JSON.stringify(await c.evaluate(`window.api.addDevice({ip: ${JSON.stringify(ip)}}).then(d => ({name: d.name, leds: d.leds, fps: d.frameRate}))`)));
      await c.evaluate('loadScene()');
      await sleep(1500);
      log(await c.shot('02_added'));
    }
    if (step === 'live') {
      await c.evaluate(`document.querySelector('[data-tab=live]').click()`);
      await c.evaluate(`window.api.liveStart({pattern: 'rainbow', params: {speed: 0.4}, fps: 20})`);
      await sleep(2500);
      log(JSON.stringify(await c.evaluate('window.api.status()')));
      log(await c.shot('03_live'));
      await c.evaluate(`window.api.liveStart({pattern: 'plasma', params: {speed: 0.6, scale: 1.5}, fps: 13})`);
      await sleep(1500);
      log(await c.shot('04_plasma'));
      await c.evaluate(`window.api.liveStop({})`);
      await sleep(1500);
      log(JSON.stringify(await c.evaluate('window.api.status()')));
    }
    if (step === 'controls') {
      log('brightness', JSON.stringify(await c.evaluate('window.api.setBrightness({value: 70})')));
      log('effect', JSON.stringify(await c.evaluate('window.api.setEffect({effectId: 2})')));
      await sleep(800);
      log('status', JSON.stringify(await c.evaluate('window.api.status()')));
      log('color', JSON.stringify(await c.evaluate('window.api.setColor({r: 255, g: 120, b: 30})')));
      await sleep(800);
      log('status', JSON.stringify(await c.evaluate('window.api.status()')));
      log('preset', JSON.stringify(await c.evaluate(`window.api.savePreset({name: 'Test rainbow', preset: {pattern: 'rainbow', params: {speed: 0.3, scale: 1, angle: 90, density: 0.5, color1: '#ff5a00', color2: '#0040ff'}, fps: 13, brightness: 100, movieSeconds: 10}})`)));
      log('apply', JSON.stringify(await c.evaluate(`window.api.applyPreset({name: 'Test rainbow'})`)));
      await sleep(1500);
      log('status', JSON.stringify(await c.evaluate('window.api.status()')));
      log('schedule', JSON.stringify(await c.evaluate(`window.api.setSchedule({entries: [{enabled: true, time: '17:30', action: 'live', preset: 'Test rainbow', days: [0,1,2,3,4,5,6]}, {enabled: true, time: '23:00', action: 'off', days: []}]})`)));
      log('next', JSON.stringify((await c.evaluate('window.api.status()')).next));
      await c.evaluate(`document.querySelector('[data-tab=schedule]').click()`);
      await sleep(600);
      log(await c.shot('05_schedule'));
      await c.evaluate(`window.api.liveStop({mode: 'effect'})`);
      log('brightness back', JSON.stringify(await c.evaluate('window.api.setBrightness({value: 100})')));
    }
    if (step === 'media') {
      const gif = process.argv[3];
      await c.evaluate(`document.querySelector('[data-tab=media]').click()`);
      await c.setFile('#mFile', gif);
      await c.evaluate(`loadMediaFile(document.querySelector('#mFile').files[0])`);
      for (let i = 0; i < 40; i++) { await sleep(500); if (await c.evaluate('!!M.clip')) break; }
      log('info', await c.evaluate(`document.querySelector('#mInfo').textContent`));
      log('clip', JSON.stringify(await c.evaluate('M.clip ? {fps: M.clip.fps, count: M.clip.count, devices: Object.keys(M.clip.devices).map(k => M.clip.devices[k].length)} : null')));
      await sleep(800);
      log(await c.shot('06_media_preview'));
      log('play', JSON.stringify(await c.evaluate(`document.querySelector('#mPlay').click(), new Promise(r => setTimeout(() => r(true), 2500))`)));
      log('status', JSON.stringify(await c.evaluate('window.api.status()')));
      log(await c.shot('07_media_live'));
      log('preset', JSON.stringify(await c.evaluate(`window.api.mediaPreset({name: 'Ball gif', clip: clipForIpc(), source: M.name, brightness: 100}).then(p => Object.keys(p))`)));
      log('upload', JSON.stringify(await c.evaluate(`window.api.mediaSave({title: 'Ball test', clip: clipForIpc()})`)));
      await sleep(1000);
      log('status', JSON.stringify(await c.evaluate('window.api.status()')));
    }
    if (step === 'load') {
      const gif = process.argv[3];
      await c.evaluate(`document.querySelector('[data-tab=media]').click()`);
      await c.setFile('#mFile', gif);
      await c.evaluate(`loadMediaFile(document.querySelector('#mFile').files[0])`);
      for (let i = 0; i < 60; i++) { await sleep(500); if (await c.evaluate('!!M.clip')) break; }
      log('info', await c.evaluate(`document.querySelector('#mInfo').textContent`));
      await c.evaluate(`document.querySelector('#mPlay').click(), new Promise(r => setTimeout(() => r(true), 3000))`);
      log('status', JSON.stringify(await c.evaluate('window.api.status()')));
      log(await c.shot('10_loaded'));
    }
    if (step === 'cleanup') {
      log('delete movies', JSON.stringify(await c.evaluate('window.api.deleteMovies()')));
      log('delete presets', JSON.stringify(await c.evaluate(`window.api.deletePreset({name: 'Ball gif'}).then(() => window.api.deletePreset({name: 'Test rainbow'})).then(p => Object.keys(p))`)));
      log('schedule cleared', JSON.stringify(await c.evaluate(`window.api.setSchedule({entries: []})`)));
      log('status', JSON.stringify(await c.evaluate('window.api.status()')));
      log('log', JSON.stringify(await c.evaluate('window.api.getLog()'), null, 1));
    }
    if (step === 'eval') {
      log(JSON.stringify(await c.evaluate(process.argv[3])));
    }
    if (step === 'shot') {
      log(await c.shot(process.argv[3] || 'shot'));
    }
  } finally { c.close(); }
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
