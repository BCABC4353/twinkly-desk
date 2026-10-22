const L = { movies: [], playlist: [] };

async function renderLibrary() {
  const r = await safe(window.api.libraryList());
  if (!r) return;
  L.movies = r.movies;
  const sets = S.scene.devices;
  $('#libList').innerHTML = L.movies.length ? L.movies.map((m) => {
    const onAll = sets.every((d) => m.sets[d.id]);
    const playing = sets.some((d) => m.sets[d.id] && m.sets[d.id].current);
    const where = onAll ? 'on every set' : 'only on ' + sets.filter((d) => m.sets[d.id]).map((d) => d.name).join(', ');
    return `<div class="card" data-n="${m.name}"><div class="name">${m.name} ${playing ? '<span class="tag">PLAYING</span>' : ''}</div><div class="meta">${m.frames} frames at ${m.fps} fps (${(m.frames / m.fps).toFixed(0)} s) · ${where}</div><div class="actions"><button data-a="play" class="primary">Play</button></div></div>`;
  }).join('') : '<p class="dim">Nothing stored yet. Use "Keep on the lights" in the Live or Media tab.</p>';
  $$('#libList .card').forEach((card) => {
    card.querySelector('[data-a=play]').onclick = () => safe(window.api.libraryPlay({ name: card.dataset.n })).then((res) => { perSetResult(res, `Playing "${card.dataset.n}" on the lights`); poll(); renderLibrary(); });
  });
  const caps = sets.map((d) => r.perDevice[d.id]).filter((x) => x && !x.error);
  if (caps.length) $('#libCap').textContent = caps.map((x, i) => `${sets[i].name}: ${x.capacity - x.available} of ${x.capacity} frames used, ${x.movies.length} of ${x.max} movies`).join(' · ');
  const sel = $('#plAdd');
  sel.innerHTML = L.movies.filter((m) => sets.every((d) => m.sets[d.id])).map((m) => `<option>${m.name}</option>`).join('') || '<option value="">(store something on every set first)</option>';
  renderPlaylist();
}

function renderPlaylist() {
  $('#plList').innerHTML = L.playlist.length ? L.playlist.map((e, i) => `<div class="row" data-i="${i}"><span class="grow">${i + 1}. ${e.name}</span><input type="number" data-f="seconds" value="${e.seconds}" min="5" max="3600"><span class="dim">s</span><button data-a="up">↑</button><button data-a="del" class="danger">✕</button></div>`).join('') : '<p class="dim">Empty. Add stored movies below.</p>';
  $$('#plList .row').forEach((row) => {
    const i = +row.dataset.i;
    row.querySelector('[data-f=seconds]').onchange = (ev) => { L.playlist[i].seconds = +ev.target.value; };
    row.querySelector('[data-a=up]').onclick = () => { if (i > 0) { [L.playlist[i - 1], L.playlist[i]] = [L.playlist[i], L.playlist[i - 1]]; renderPlaylist(); } };
    row.querySelector('[data-a=del]').onclick = () => { L.playlist.splice(i, 1); renderPlaylist(); };
  });
  $('#plInfo').textContent = L.playlist.length ? `Loop length ${L.playlist.reduce((a, e) => a + e.seconds, 0)} s` : '';
}

$('#libRefresh').onclick = renderLibrary;
$('#libDeleteAll').onclick = async () => { await safe(window.api.deleteMovies(), 'All stored movies deleted'); L.playlist = []; poll(); renderLibrary(); };
$('#plAddBtn').onclick = () => { const name = $('#plAdd').value; if (!name) return; L.playlist.push({ name, seconds: +$('#plSecs').value || 60 }); renderPlaylist(); };
$('#plPlay').onclick = async () => {
  if (!L.playlist.length) return status('Add at least one entry to the playlist');
  const r = await safe(window.api.playlistPlay({ entries: L.playlist }));
  perSetResult(r, 'Playlist running on the lights');
  poll();
};
$('#plStop').onclick = async () => { const r = await safe(window.api.playlistStop()); perSetResult(r, 'Back to the single stored movie'); poll(); };

$$('#tabs button').forEach((b) => b.addEventListener('click', () => { if (b.dataset.tab === 'library') renderLibrary(); }));
