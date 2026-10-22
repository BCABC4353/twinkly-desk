function defaultPlace(scene) {
  let maxX = 0;
  for (const d of scene.devices) maxX = Math.max(maxX, d.place.x + d.place.w);
  return { x: scene.devices.length ? maxX + 20 : 0, y: 0, w: 200, h: 100, rot: 0 };
}

function localToWorld(place, lx, ly) {
  const a = (place.rot * Math.PI) / 180;
  const ca = Math.cos(a), sa = Math.sin(a);
  const dx = ((lx + 1) / 2 - 0.5) * place.w;
  const dy = (ly - 0.5) * place.h;
  const cx = place.x + place.w / 2, cy = place.y + place.h / 2;
  return [cx + dx * ca - dy * sa, cy + dx * sa + dy * ca];
}

function worldToLocal(place, wx, wy) {
  const a = (-place.rot * Math.PI) / 180;
  const ca = Math.cos(a), sa = Math.sin(a);
  const cx = place.x + place.w / 2, cy = place.y + place.h / 2;
  const ex = wx - cx, ey = wy - cy;
  const dx = ex * ca - ey * sa, dy = ex * sa + ey * ca;
  return [(dx / place.w + 0.5) * 2 - 1, dy / place.h + 0.5];
}

function corners(place) {
  return [[-1, 0], [1, 0], [1, 1], [-1, 1]].map(([lx, ly]) => localToWorld(place, lx, ly));
}

function buildWorld(scene) {
  const segs = [];
  const worldPts = [];
  let total = 0;
  for (const d of scene.devices) {
    segs.push({ id: d.id, start: total, count: d.layout.length, bytesPerLed: d.bytesPerLed || 3 });
    for (const c of d.layout) worldPts.push(localToWorld(d.place, c.x, c.y));
    total += d.layout.length;
  }
  let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
  for (const d of scene.devices) for (const [x, y] of corners(d.place)) {
    if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y;
  }
  if (!isFinite(minx)) { minx = 0; maxx = 1; miny = 0; maxy = 1; }
  const sx = maxx - minx || 1, sy = maxy - miny || 1;
  const pts = new Float32Array(total * 2);
  for (let i = 0; i < total; i++) {
    pts[2 * i] = (worldPts[i][0] - minx) / sx;
    pts[2 * i + 1] = (worldPts[i][1] - miny) / sy;
  }
  return { pts, segs, total, world: worldPts, bounds: { minx, maxx, miny, maxy } };
}

module.exports = { defaultPlace, localToWorld, worldToLocal, corners, buildWorld };
