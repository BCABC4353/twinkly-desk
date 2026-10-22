const fs = require('fs');
const path = require('path');

const EMPTY = {
  scene: { version: 0, units: 'in', devices: [] },
  presets: {},
  schedule: [],
  settings: { keepRunning: true, openAtLogin: false, startMinimized: false, streamHz: 20 },
};

class Store {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'state.json');
    this.data = JSON.parse(JSON.stringify(EMPTY));
    this.saveTimer = null;
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.data = Object.assign({}, EMPTY, raw);
      this.data.scene = Object.assign({}, EMPTY.scene, raw.scene || {});
      this.data.settings = Object.assign({}, EMPTY.settings, raw.settings || {});
      for (const d of this.data.scene.devices) d.place = Object.assign({ x: 0, y: 0, w: 200, h: 100, rot: 0 }, d.place || {});
    } catch {
      this.data = JSON.parse(JSON.stringify(EMPTY));
    }
  }

  save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), 250);
  }

  flush() {
    clearTimeout(this.saveTimer);
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
  }

  backup(name, obj) {
    const dir = path.join(this.dir, 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(dir, `${name}_${stamp}.json`);
    fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
    return file;
  }
}

module.exports = { Store };
