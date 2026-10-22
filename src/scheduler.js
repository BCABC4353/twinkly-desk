class Scheduler {
  constructor(getEntries, runAction, log) {
    this.getEntries = getEntries;
    this.runAction = runAction;
    this.log = log || (() => {});
    this.fired = {};
    this.timer = setInterval(() => this.check(), 15000);
    this.check();
  }

  check() {
    const now = new Date();
    const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const dayKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
    for (const e of this.getEntries()) {
      if (!e.enabled || e.time !== hhmm) continue;
      if (Array.isArray(e.days) && e.days.length && !e.days.includes(now.getDay())) continue;
      const key = `${e.id}:${dayKey}:${e.time}`;
      if (this.fired[key]) continue;
      this.fired[key] = true;
      this.log(`schedule: ${e.action} ${e.preset || ''} at ${hhmm}`);
      Promise.resolve(this.runAction(e)).catch((err) => this.log(`schedule failed: ${err.message}`));
    }
  }

  next() {
    const now = new Date();
    let best = null;
    for (const e of this.getEntries()) {
      if (!e.enabled || !e.time) continue;
      const [h, m] = e.time.split(':').map(Number);
      for (let add = 0; add < 8; add++) {
        const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + add, h, m, 0, 0);
        if (d <= now) continue;
        if (Array.isArray(e.days) && e.days.length && !e.days.includes(d.getDay())) continue;
        if (!best || d < best.at) best = { at: d, entry: e };
        break;
      }
    }
    return best ? { at: best.at.toISOString(), action: best.entry.action, preset: best.entry.preset || null } : null;
  }

  stop() { clearInterval(this.timer); }
}

module.exports = { Scheduler };
