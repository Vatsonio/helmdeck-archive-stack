/* HELMDECK archive viewer.
 *
 * Playback model: the server publishes every recording as an HLS VOD playlist of
 * fragmented-MP4 segments (hvc1), so hls.js only ever has to push fMP4 into MSE.
 * That is the only shape a browser can decode H.265 in; the previous build fed
 * it HEVC inside MPEG-TS, which hls.js rejects outright ("Unsupported HEVC in
 * M2TS found"), so nothing ever played.
 *
 * Two clocks run side by side and must not be confused:
 *   - PLAYBACK time, `video.currentTime`, is continuous across a recording gap.
 *   - WALL time is what telemetry, the OSD and clip export are keyed by.
 * `wallAt()` / `playbackAt()` convert between them using the segment table,
 * which carries both.
 */

'use strict';

const $ = (id) => document.getElementById(id);
const el = {
  tree: $('tree'), crumb: $('crumb'), video: $('video'), osd: $('osd'),
  notice: $('notice'), empty: $('empty'),
  timeline: $('timeline'), tlCanvas: $('tlCanvas'), tlHead: $('tlHead'),
  clock: $('clock'), rel: $('rel'), segNow: $('segNow'),
  map: $('map'), mapPanel: $('mapPanel'), mapCoord: $('mapCoord'),
  graph: $('graph'), legend: $('legend'),
  osdBtn: $('osdBtn'), mapBtn: $('mapBtn'), rate: $('rate'),
  inBtn: $('inBtn'), outBtn: $('outBtn'), clipLbl: $('clipLbl'), clipClr: $('clipClr'),
  dlSeg: $('dlSeg'), exportBtn: $('exportBtn'),
  keys: $('keys'), keysBtn: $('keysBtn'),
};

const S = {
  sel: null,           // {node, cam, day}
  segments: [],        // [{start_ms, dur, cum, path, disc}]
  totalDur: 0,
  telemetry: [],       // [{t, p}] for the whole selection, sorted by t
  hls: null,
  showOsd: true,
  showMap: true,
  clipIn: null,        // wall ms
  clipOut: null,
};

const api = async (path) => {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${r.status} on ${path.split('?')[0]}`);
  return r.json();
};
const pad = (n, w = 2) => String(n).padStart(w, '0');
const selKey = (s) => s && `${s.node}/${s.cam}/${s.day}`;

const hhmmss = (ms) => {
  const d = new Date(ms);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
};
const hms = (sec) => {
  sec = Math.max(0, Math.floor(sec));
  return `${pad(Math.floor(sec / 3600))}:${pad(Math.floor(sec / 60) % 60)}:${pad(sec % 60)}`;
};

/* --- the two clocks ------------------------------------------------------ */

/** Wall-clock ms for a playback offset. */
function wallAt(t) {
  const segs = S.segments;
  if (!segs.length) return 0;
  for (let i = segs.length - 1; i >= 0; i--) {
    if (t >= segs[i].cum - 1e-6) return segs[i].start_ms + (t - segs[i].cum) * 1000;
  }
  return segs[0].start_ms;
}

/** Playback offset for a wall-clock ms. A time inside a recording gap maps to
 *  the start of the next segment, which is where playback actually resumes. */
function playbackAt(wallMs) {
  const segs = S.segments;
  if (!segs.length) return 0;
  for (const s of segs) {
    if (wallMs < s.start_ms) return s.cum;
    if (wallMs <= s.start_ms + s.dur * 1000) return s.cum + (wallMs - s.start_ms) / 1000;
  }
  return S.totalDur;
}

function segmentAt(t) {
  const segs = S.segments;
  for (let i = segs.length - 1; i >= 0; i--) if (t >= segs[i].cum - 1e-6) return segs[i];
  return segs[0] || null;
}

/* --- capability ---------------------------------------------------------- */

/** Can this browser decode our recordings at all? Answered up front, because a
 *  silent black frame is the worst possible failure mode for a viewer. */
function hevcSupport() {
  if (!window.MediaSource || !window.MediaSource.isTypeSupported) {
    return { ok: false, why: 'This browser has no Media Source Extensions.' };
  }
  const ok = [
    'video/mp4; codecs="hvc1.1.6.L120.B0"',
    'video/mp4; codecs="hvc1.2.4.L120.B0"',
    'video/mp4; codecs="hev1.1.6.L120.B0"',
  ].some((t) => window.MediaSource.isTypeSupported(t));
  return ok ? { ok: true } : {
    ok: false,
    why: 'This browser cannot decode H.265 (HEVC).',
    hint: 'Chrome on Windows decodes it with no extra software. Edge needs the ' +
          'Microsoft HEVC Video Extension. Either way EXPORT still gives you a ' +
          'file that plays in VLC or any desktop player.',
  };
}

function notice(html) {
  if (!html) { el.notice.hidden = true; return; }
  el.notice.innerHTML = html;
  el.notice.hidden = false;
}

/* --- archive tree -------------------------------------------------------- */

async function loadTree() {
  let data;
  try {
    data = await api('/api/tree');
  } catch (e) {
    el.tree.innerHTML = `<div class="empty">ARCHIVE UNREACHABLE<br><br>${e.message}</div>`;
    return;
  }
  if (!data.nodes.length) {
    el.tree.innerHTML = '<div class="empty">NO RECORDINGS YET<br><br>' +
      'Operator stations publish here<br>automatically while they stream.</div>';
    return;
  }
  const frag = document.createDocumentFragment();
  for (const n of data.nodes) {
    const nd = document.createElement('div');
    nd.className = 'node';
    nd.textContent = n.node;
    frag.appendChild(nd);
    for (const c of n.cameras) {
      const cd = document.createElement('div');
      cd.className = 'cam';
      cd.textContent = c.cam;
      frag.appendChild(cd);
      for (const d of c.days) {
        const dd = document.createElement('div');
        dd.className = 'day';
        dd.dataset.key = `${n.node}/${c.cam}/${d.day}`;
        const day = document.createElement('span');
        day.textContent = d.day;
        const cnt = document.createElement('span');
        cnt.className = 'n';
        cnt.textContent = d.segments;
        dd.append(day, cnt);
        dd.onclick = () => select(n.node, c.cam, d.day);
        frag.appendChild(dd);
      }
    }
  }
  el.tree.replaceChildren(frag);
  markSelected();
}

function markSelected() {
  const key = selKey(S.sel);
  for (const d of el.tree.querySelectorAll('.day')) {
    d.classList.toggle('sel', d.dataset.key === key);
  }
}

/* --- selection ----------------------------------------------------------- */

async function select(node, cam, day) {
  S.sel = { node, cam, day };
  S.clipIn = S.clipOut = null;
  S.telemetry = [];
  markSelected();
  el.crumb.textContent = `${node} / ${cam} / ${day}`;
  el.crumb.classList.remove('none');
  el.empty.hidden = true;
  notice('LOADING');

  const q = `node=${encodeURIComponent(node)}&cam=${encodeURIComponent(cam)}&day=${encodeURIComponent(day)}`;
  let info;
  try {
    info = await api(`/api/segments?${q}`);
  } catch (e) {
    notice(`COULD NOT LOAD THIS RECORDING<span class="hint">${e.message}</span>`);
    return;
  }
  if (selKey(S.sel) !== `${node}/${cam}/${day}`) return;
  S.segments = info.segments;
  S.totalDur = info.total_dur;
  updateExportLink();

  const cap = hevcSupport();
  notice(cap.ok ? '' : `<b>${cap.why}</b><span class="hint">${cap.hint || ''}</span>`);
  attachPlayer(`/api/hls?${q}`);
  loadTelemetry();
}

function attachPlayer(url) {
  if (S.hls) { S.hls.destroy(); S.hls = null; }
  const v = el.video;
  v.removeAttribute('src');
  v.load();

  if (window.Hls && window.Hls.isSupported()) {
    const hls = new window.Hls({ enableWorker: true, backBufferLength: 90, maxBufferLength: 30 });
    S.hls = hls;
    hls.on(window.Hls.Events.ERROR, (_evt, data) => {
      if (!data.fatal) return;
      const detail = `${data.type} / ${data.details}`;
      if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR) {
        notice(`NETWORK ERROR, RETRYING<span class="hint">${detail}</span>`);
        hls.startLoad();
      } else if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR) {
        notice(`MEDIA ERROR, RECOVERING<span class="hint">${detail}</span>`);
        hls.recoverMediaError();
      } else {
        notice(`PLAYBACK FAILED<span class="hint">${detail}</span>`);
        hls.destroy();
        S.hls = null;
      }
    });
    hls.on(window.Hls.Events.MANIFEST_PARSED, () => {
      notice('');
      v.play().catch(() => {});
    });
    hls.loadSource(url);
    hls.attachMedia(v);
  } else if (v.canPlayType('application/vnd.apple.mpegurl')) {
    v.src = url;                                   // Safari plays HLS natively
    v.play().catch(() => {});
  } else {
    notice('<b>This browser cannot play HLS.</b><span class="hint">Use Chrome, or EXPORT the recording.</span>');
  }
  v.playbackRate = parseFloat(el.rate.value);
  v.controls = true;
}

/* --- telemetry ----------------------------------------------------------- */

async function loadTelemetry() {
  if (!S.segments.length) return;
  const key = selKey(S.sel);
  const first = S.segments[0];
  const last = S.segments[S.segments.length - 1];
  const start = Math.floor(first.start_ms - 1000);
  const end = Math.ceil(last.start_ms + last.dur * 1000 + 1000);
  try {
    const d = await api(`/api/telemetry?node=${encodeURIComponent(S.sel.node)}&start=${start}&end=${end}`);
    if (selKey(S.sel) !== key) return;            // selection changed while loading
    S.telemetry = d.samples;
  } catch {
    S.telemetry = [];
  }
  el.mapPanel.hidden = !(S.showMap && S.telemetry.length);
  drawTimeline();
}

/** Nearest sample at or before `wallMs`, or null when the nearest is far away. */
function sampleAt(wallMs) {
  const a = S.telemetry;
  if (!a.length) return null;
  let lo = 0, hi = a.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (a[mid].t <= wallMs) { best = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  return best < 0 || wallMs - a[best].t > 5000 ? null : a[best];
}

/* --- canvases ------------------------------------------------------------ */

function fit(canvas) {
  const r = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(r.width * dpr));
  const h = Math.max(1, Math.round(r.height * dpr));
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w: r.width, h: r.height };
}

function pickStep(spanMs) {
  const steps = [60e3, 300e3, 600e3, 1800e3, 3600e3, 7200e3, 21600e3];
  for (const s of steps) if (spanMs / s <= 12) return s;
  return steps[steps.length - 1];
}

function drawTimeline() {
  const { ctx, w, h } = fit(el.tlCanvas);
  ctx.clearRect(0, 0, w, h);
  if (!S.segments.length || !S.totalDur) return;

  ctx.fillStyle = '#0d0a06';
  ctx.fillRect(0, 0, w, h);

  // Recorded spans, laid out on PLAYBACK time so the bar matches seeking.
  for (const s of S.segments) {
    const x = (s.cum / S.totalDur) * w;
    ctx.fillStyle = '#4a3a1c';
    ctx.fillRect(x, 8, Math.max(1, (s.dur / S.totalDur) * w), h - 20);
    if (s.disc) {                        // seam: the publisher reconnected here
      ctx.fillStyle = '#e04a3a';
      ctx.fillRect(x, 4, 1.5, h - 12);
    }
  }

  if (S.clipIn != null && S.clipOut != null) {
    const a = (playbackAt(S.clipIn) / S.totalDur) * w;
    const b = (playbackAt(S.clipOut) / S.totalDur) * w;
    ctx.fillStyle = 'rgba(224,176,47,.28)';
    ctx.fillRect(Math.min(a, b), 8, Math.abs(b - a), h - 20);
  }
  for (const m of [S.clipIn, S.clipOut]) {
    if (m == null) continue;
    ctx.fillStyle = '#e0b02f';
    ctx.fillRect((playbackAt(m) / S.totalDur) * w - 1, 4, 2, h - 12);
  }

  ctx.fillStyle = '#5a5044';
  ctx.font = '9px ui-monospace, monospace';
  const startWall = S.segments[0].start_ms;
  const endWall = wallAt(S.totalDur);
  const step = pickStep(endWall - startWall);
  for (let t = Math.ceil(startWall / step) * step; t <= endWall; t += step) {
    const x = (playbackAt(t) / S.totalDur) * w;
    ctx.fillRect(x, h - 10, 1, 4);
    ctx.fillText(hhmmss(t).slice(0, 5), x + 3, h - 2);
  }
}

function drawOsd() {
  const { ctx, w, h } = fit(el.osd);
  ctx.clearRect(0, 0, w, h);
  if (!S.showOsd || !S.segments.length) return;
  const wall = wallAt(el.video.currentTime);
  const s = sampleAt(wall);
  const p = (s && s.p) || {};
  const m = 14;

  ctx.font = '600 13px ui-monospace, monospace';
  ctx.textBaseline = 'top';
  ctx.shadowColor = 'rgba(0,0,0,.9)';
  ctx.shadowBlur = 4;

  ctx.fillStyle = '#f0ece3';
  ctx.fillText(`${S.sel.day} ${hhmmss(wall)}Z`, m, m);
  ctx.fillStyle = '#8a7d6a';
  ctx.fillText(`${S.sel.node} / ${S.sel.cam}`, m, m + 18);

  if (!s) {
    ctx.fillStyle = '#5a5044';
    ctx.fillText('NO TELEMETRY', m, m + 40);
    ctx.shadowBlur = 0;
    return;
  }

  const rows = [
    ['SPD', p.speed_kmh != null ? `${p.speed_kmh.toFixed(1)} km/h` : null],
    ['ALT', p.alt_m != null ? `${p.alt_m.toFixed(1)} m` : null],
    ['HDG', p.heading_deg != null ? `${Math.round(p.heading_deg)} deg` : null],
  ].filter((r) => r[1]);
  let y = h - m - rows.length * 18;
  for (const [k, v] of rows) {
    ctx.fillStyle = '#8a7d6a'; ctx.fillText(k, m, y);
    ctx.fillStyle = '#f0ece3'; ctx.fillText(v, m + 40, y);
    y += 18;
  }

  const right = [];
  if (p.battery_v != null) right.push(`${p.battery_v.toFixed(1)}V`);
  if (p.battery_pct != null) right.push(`${Math.round(p.battery_pct)}%`);
  if (p.gps_sats != null) right.push(`SAT ${p.gps_sats}`);
  if (p.gps_fix) right.push(String(p.gps_fix));
  if (p.mode) right.push(String(p.mode));
  ctx.textAlign = 'right';
  let ry = m;
  for (const line of right) { ctx.fillStyle = '#f0ece3'; ctx.fillText(line, w - m, ry); ry += 18; }
  if (p.lat != null && p.lon != null) {
    ctx.fillStyle = '#8a7d6a';
    ctx.fillText(`${p.lat.toFixed(6)} ${p.lon.toFixed(6)}`, w - m, h - m - 16);
  }
  ctx.textAlign = 'left';
  ctx.shadowBlur = 0;
}

function drawMap() {
  if (el.mapPanel.hidden) return;
  const { ctx, w, h } = fit(el.map);
  ctx.clearRect(0, 0, w, h);
  const pts = [];
  for (const s of S.telemetry) {
    const p = s.p || {};
    if (typeof p.lat === 'number' && typeof p.lon === 'number' && (p.lat || p.lon)) pts.push(p);
  }
  if (pts.length < 2) {
    ctx.fillStyle = '#5a5044';
    ctx.font = '10px ui-monospace, monospace';
    ctx.fillText('NO POSITION DATA', 10, 20);
    el.mapCoord.textContent = '';
    return;
  }
  let minLa = Infinity, maxLa = -Infinity, minLo = Infinity, maxLo = -Infinity;
  for (const p of pts) {
    minLa = Math.min(minLa, p.lat); maxLa = Math.max(maxLa, p.lat);
    minLo = Math.min(minLo, p.lon); maxLo = Math.max(maxLo, p.lon);
  }
  // A degree of longitude shrinks with latitude; without this the track is
  // stretched sideways and the shape lies.
  const midLa = (minLa + maxLa) / 2;
  const midLo = (minLo + maxLo) / 2;
  const kx = Math.cos((midLa * Math.PI) / 180) || 1;
  const sc = Math.min(
    (w - 24) / Math.max((maxLo - minLo) * kx, 1e-6),
    (h - 24) / Math.max(maxLa - minLa, 1e-6),
  );
  const X = (lo) => w / 2 + (lo - midLo) * kx * sc;
  const Y = (la) => h / 2 - (la - midLa) * sc;

  ctx.strokeStyle = '#6b5a33';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(X(p.lon), Y(p.lat)) : ctx.moveTo(X(p.lon), Y(p.lat))));
  ctx.stroke();

  const s = sampleAt(wallAt(el.video.currentTime));
  if (s && s.p && typeof s.p.lat === 'number' && typeof s.p.lon === 'number') {
    ctx.fillStyle = '#e0b02f';
    ctx.beginPath();
    ctx.arc(X(s.p.lon), Y(s.p.lat), 4, 0, Math.PI * 2);
    ctx.fill();
    el.mapCoord.textContent = `${s.p.lat.toFixed(5)} ${s.p.lon.toFixed(5)}`;
  } else {
    el.mapCoord.textContent = '';
  }
}

function drawGraph() {
  const { ctx, w, h } = fit(el.graph);
  ctx.clearRect(0, 0, w, h);
  if (!S.segments.length) return;
  const t0 = S.segments[0].start_ms;
  const span = Math.max(1, wallAt(S.totalDur) - t0);

  const legend = [];
  for (const s of [
    { key: 'speed_kmh', color: '#6fcf7a', label: 'SPD' },
    { key: 'alt_m', color: '#e0b02f', label: 'ALT' },
  ]) {
    const pts = [];
    for (const smp of S.telemetry) {
      const v = smp.p && smp.p[s.key];
      if (typeof v === 'number') pts.push([smp.t, v]);
    }
    if (pts.length < 2) continue;
    let lo = Infinity, hi = -Infinity;
    for (const [, v] of pts) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    if (hi - lo < 1e-6) hi = lo + 1;
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    pts.forEach(([t, v], i) => {
      const x = ((t - t0) / span) * w;
      const y = h - 8 - ((v - lo) / (hi - lo)) * (h - 20);
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.stroke();
    legend.push(`<span style="color:${s.color}">${s.label} ${lo.toFixed(0)}..${hi.toFixed(0)}</span>`);
  }
  el.legend.innerHTML = legend.join(' &nbsp; ') ||
    (S.telemetry.length ? 'NO NUMERIC SERIES' : 'NO TELEMETRY');

  ctx.fillStyle = '#e0b02f';
  ctx.fillRect(((wallAt(el.video.currentTime) - t0) / span) * w - 0.5, 0, 1, h);
}

/* --- per-frame ----------------------------------------------------------- */

function tick() {
  if (S.segments.length) {
    const t = el.video.currentTime;
    const wall = wallAt(t);
    el.clock.innerHTML =
      `${hhmmss(wall)}<span class="ms">.${pad(Math.floor(new Date(wall).getUTCMilliseconds() / 10))}</span>`;
    el.rel.textContent = `${hms(t)} / ${hms(S.totalDur)}`;
    const seg = segmentAt(t);
    if (seg) {
      el.segNow.textContent = seg.path.split('/').pop();
      el.dlSeg.href = `/raw?path=${encodeURIComponent(seg.path)}&download=1`;
      el.dlSeg.hidden = false;
    }
    if (S.totalDur > 0) {
      el.tlHead.hidden = false;
      el.tlHead.style.left = `${(t / S.totalDur) * el.timeline.clientWidth}px`;
    }
    drawOsd();
    drawMap();
    drawGraph();
  }
  requestAnimationFrame(tick);
}

/* --- clip and export ----------------------------------------------------- */

/** Segments the current export range covers. */
function rangeSegments() {
  if (S.clipIn == null || S.clipOut == null || S.clipOut <= S.clipIn) return S.segments;
  return S.segments.filter(
    (s) => s.start_ms < S.clipOut && s.start_ms + s.dur * 1000 > S.clipIn);
}

/** First point where the video mode changes inside the range, if any. A stream
 *  copy cannot join those, so the export is refused server side; catching it
 *  here means the operator learns before starting a download, not after. */
function modeChange() {
  const segs = rangeSegments();
  for (let i = 1; i < segs.length; i++) {
    if (segs[i].par && segs[i - 1].par && segs[i].par !== segs[i - 1].par) {
      return { at: segs[i].start_ms, from: segs[i - 1].par, to: segs[i].par, index: i };
    }
  }
  return null;
}

function updateExportLink() {
  el.inBtn.disabled = el.outBtn.disabled = !S.segments.length;
  if (!S.sel || !S.segments.length) { el.exportBtn.hidden = true; return; }
  const q = new URLSearchParams({ node: S.sel.node, cam: S.sel.cam, day: S.sel.day });
  let label = 'EXPORT DAY';
  if (S.clipIn != null && S.clipOut != null && S.clipOut > S.clipIn) {
    q.set('start_ms', String(Math.floor(S.clipIn)));
    q.set('end_ms', String(Math.floor(S.clipOut)));
    label = `EXPORT ${hms((S.clipOut - S.clipIn) / 1000)}`;
  }
  const mc = modeChange();
  el.exportBtn.href = mc ? '#' : `/api/export?${q.toString()}`;
  el.exportBtn.textContent = mc ? 'EXPORT BLOCKED' : label;
  el.exportBtn.classList.toggle('go', !mc);
  el.exportBtn.title = mc
    ? `Video mode changes at ${hhmmss(mc.at)} (${mc.from} -> ${mc.to}). Click to clip up to it.`
    : '';
  el.exportBtn.hidden = false;

  const parts = [];
  if (S.clipIn != null) parts.push(`IN ${hhmmss(S.clipIn)}`);
  if (S.clipOut != null) parts.push(`OUT ${hhmmss(S.clipOut)}`);
  el.clipLbl.textContent = parts.join('  ');
  el.clipClr.hidden = !parts.length;
  drawTimeline();
}

/* --- input --------------------------------------------------------------- */

const seekPlayback = (t) => {
  el.video.currentTime = Math.max(0, Math.min(Math.max(0, S.totalDur - 0.05), t));
};

el.timeline.addEventListener('click', (e) => {
  if (!S.totalDur) return;
  const r = el.timeline.getBoundingClientRect();
  seekPlayback(((e.clientX - r.left) / r.width) * S.totalDur);
});

el.graph.addEventListener('click', (e) => {
  if (!S.segments.length) return;
  const r = el.graph.getBoundingClientRect();
  const t0 = S.segments[0].start_ms;
  const span = Math.max(1, wallAt(S.totalDur) - t0);
  seekPlayback(playbackAt(t0 + ((e.clientX - r.left) / r.width) * span));
});

const setIn = () => { S.clipIn = wallAt(el.video.currentTime); updateExportLink(); };
const setOut = () => { S.clipOut = wallAt(el.video.currentTime); updateExportLink(); };

el.osdBtn.onclick = () => { S.showOsd = !S.showOsd; el.osdBtn.classList.toggle('on', S.showOsd); };
el.mapBtn.onclick = () => {
  S.showMap = !S.showMap;
  el.mapBtn.classList.toggle('on', S.showMap);
  el.mapPanel.hidden = !(S.showMap && S.telemetry.length);
};
el.rate.onchange = () => { el.video.playbackRate = parseFloat(el.rate.value); };
el.inBtn.onclick = setIn;
el.outBtn.onclick = setOut;
el.clipClr.onclick = () => { S.clipIn = S.clipOut = null; updateExportLink(); };
el.keysBtn.onclick = () => { el.keys.hidden = !el.keys.hidden; };
el.keys.onclick = () => { el.keys.hidden = true; };

document.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  const v = el.video;
  const step = e.shiftKey ? 60 : 5;
  switch (e.key) {
    case ' ': case 'k': e.preventDefault(); v.paused ? v.play() : v.pause(); break;
    case 'ArrowLeft': seekPlayback(v.currentTime - step); break;
    case 'ArrowRight': seekPlayback(v.currentTime + step); break;
    case '[': { const s = segmentAt(v.currentTime); if (s) seekPlayback(s.cum - 0.01); break; }
    case ']': { const s = segmentAt(v.currentTime); if (s) seekPlayback(s.cum + s.dur + 0.01); break; }
    case ',': if (v.paused) seekPlayback(v.currentTime - 0.04); break;
    case '.': if (v.paused) seekPlayback(v.currentTime + 0.04); break;
    case 'i': setIn(); break;
    case 'o': setOut(); break;
    case '?': el.keys.hidden = !el.keys.hidden; break;
    case 'Escape': el.keys.hidden = true; break;
  }
});

window.addEventListener('resize', drawTimeline);

/* --- boot ---------------------------------------------------------------- */

const boot = hevcSupport();
if (!boot.ok) notice(`<b>${boot.why}</b><span class="hint">${boot.hint || ''}</span>`);
loadTree();
setInterval(loadTree, 60000);
requestAnimationFrame(tick);
