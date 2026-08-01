/* HELMDECK archive viewer.
 *
 * This is the operator station in replay: the same OSD panels, driven by the
 * telemetry log recorded alongside the video, over the recorded feed. The video
 * element carries NO native controls; the transport below the stage is the only
 * one, so nothing of the browser's own player is ever visible.
 *
 * Playback: the server publishes each recording as an HLS VOD playlist of
 * fragmented-MP4 segments (hvc1), the only shape a browser can decode H.265 in.
 *
 * Two clocks run side by side and must not be confused:
 *   - PLAYBACK time, `video.currentTime`, is continuous across a recording gap.
 *   - WALL time is what telemetry, the OSD and clip export are keyed by.
 */

'use strict';

const $ = (id) => document.getElementById(id);
const el = {
  tree: $('tree'), video: $('video'), osd: $('osd'),
  notice: $('notice'), empty: $('empty'),
  compass: $('compassC'), tilt: $('tilt'),
  panelL: $('panelL'), panelR: $('panelR'), coordStrip: $('coordStrip'),
  timeline: $('timeline'), tlCanvas: $('tlCanvas'), tlHead: $('tlHead'), tlHover: $('tlHover'),
  clock: $('clock'), rel: $('rel'), segNow: $('segNow'),
  map: $('map'), mapPanel: $('mapPanel'), mapCoord: $('mapCoord'),
  graph: $('graph'), legend: $('legend'),
  playBtn: $('playBtn'), prevBtn: $('prevBtn'), nextBtn: $('nextBtn'),
  osdBtn: $('osdBtn'), mapBtn: $('mapBtn'), rate: $('rate'),
  inBtn: $('inBtn'), outBtn: $('outBtn'), clipLbl: $('clipLbl'), clipClr: $('clipClr'),
  dlSeg: $('dlSeg'), exportBtn: $('exportBtn'), keys: $('keys'), keysBtn: $('keysBtn'),
  // OSD value nodes
  lnkMeta: $('lnkMeta'), vMode: $('vMode'), armRow: $('armRow'), vArm: $('vArm'),
  vSpd: $('vSpd'), vHdg: $('vHdg'), vAlt: $('vAlt'), vTilt: $('vTilt'),
  vBattV: $('vBattV'), battBar: $('battBar'), vBattA: $('vBattA'), vBattPct: $('vBattPct'),
  vFix: $('vFix'), vSats: $('vSats'), vHdop: $('vHdop'),
  vWp: $('vWp'), vWpD: $('vWpD'), vHome: $('vHome'),
  vLat: $('vLat'), vLon: $('vLon'), vUtc: $('vUtc'), vSrc: $('vSrc'),
};

const S = {
  sel: null, segments: [], totalDur: 0, telemetry: [],
  hls: null, showOsd: true, showMap: true, clipIn: null, clipOut: null, scrubbing: false,
};

const api = async (path) => {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${r.status} on ${path.split('?')[0]}`);
  return r.json();
};
const pad = (n, w = 2) => String(n).padStart(w, '0');
const selKey = (s) => s && `${s.node}/${s.cam}/${s.day}`;
const num = (v, d = 1) => (typeof v === 'number' && isFinite(v) ? v.toFixed(d) : '-');
const hhmmss = (ms) => {
  const d = new Date(ms);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
};
const hms = (sec) => {
  sec = Math.max(0, Math.floor(sec));
  return `${pad(Math.floor(sec / 3600))}:${pad(Math.floor(sec / 60) % 60)}:${pad(sec % 60)}`;
};

/* --- the two clocks ------------------------------------------------------ */

function wallAt(t) {
  const segs = S.segments;
  if (!segs.length) return 0;
  for (let i = segs.length - 1; i >= 0; i--) {
    if (t >= segs[i].cum - 1e-6) return segs[i].start_ms + (t - segs[i].cum) * 1000;
  }
  return segs[0].start_ms;
}

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
    why: 'This browser cannot decode H.265.',
    hint: 'Chrome on Windows decodes it with no extra software. Edge needs the ' +
          'Microsoft HEVC Video Extension. EXPORT still produces a file that ' +
          'plays in VLC or any desktop player.',
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
    el.tree.innerHTML = '<div class="empty">NO RECORDINGS<br><br>' +
      'Stations publish here while they stream.</div>';
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
        const a = document.createElement('span');
        a.textContent = d.day;
        const b = document.createElement('span');
        b.className = 'n';
        b.textContent = d.segments;
        dd.append(a, b);
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
  el.empty.hidden = true;
  notice('LOADING');

  const q = `node=${encodeURIComponent(node)}&cam=${encodeURIComponent(cam)}&day=${encodeURIComponent(day)}`;
  let info;
  try {
    info = await api(`/api/segments?${q}`);
  } catch (e) {
    notice(`CANNOT LOAD<span class="hint">${e.message}</span>`);
    return;
  }
  if (selKey(S.sel) !== `${node}/${cam}/${day}`) return;
  S.segments = info.segments;
  S.totalDur = info.total_dur;
  updateExportLink();
  drawTimeline();

  const cap = hevcSupport();
  notice(cap.ok ? '' : `<b>${cap.why}</b><span class="hint">${cap.hint || ''}</span>`);
  attachPlayer(`/api/hls?${q}`);
  loadTelemetry();
}

function attachPlayer(url) {
  if (S.hls) { S.hls.destroy(); S.hls = null; }
  const v = el.video;
  // No native controls, ever: the transport below the stage is the only one.
  v.controls = false;
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
    v.src = url;
    v.play().catch(() => {});
  } else {
    notice('<b>This browser cannot play HLS.</b><span class="hint">Use Chrome, or EXPORT.</span>');
  }
  v.playbackRate = parseFloat(el.rate.value);
}

/* --- telemetry ----------------------------------------------------------- */

async function loadTelemetry() {
  if (!S.segments.length) return;
  const key = selKey(S.sel);
  const first = S.segments[0];
  const last = S.segments[S.segments.length - 1];
  try {
    const d = await api(`/api/telemetry?node=${encodeURIComponent(S.sel.node)}` +
      `&start=${Math.floor(first.start_ms - 1000)}` +
      `&end=${Math.ceil(last.start_ms + last.dur * 1000 + 1000)}`);
    if (selKey(S.sel) !== key) return;
    S.telemetry = d.samples;
  } catch {
    S.telemetry = [];
  }
  el.mapPanel.hidden = !(S.showMap && S.telemetry.length);
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

/* --- OSD ----------------------------------------------------------------- */

function setText(node, v) { if (node.textContent !== v) node.textContent = v; }

function renderOsd(wall) {
  el.osd.hidden = !S.showOsd || !S.segments.length;
  if (el.osd.hidden) return;
  const s = sampleAt(wall);
  const p = (s && s.p) || {};

  setText(el.lnkMeta, s ? `+${((wall - s.t) / 1000).toFixed(2)}s` : 'NO LOG');
  el.lnkMeta.className = s ? 'meta' : 'meta crit';

  setText(el.vMode, p.mode || '-');
  const armed = p.armed === true;
  el.armRow.classList.toggle('armed', armed);
  el.armRow.classList.toggle('disarmed', !armed);
  setText(el.vArm, p.armed == null ? '-' : (armed ? '▲ ARMED' : '▼ SAFE'));

  setText(el.vSpd, num(p.speed_kmh, 1));
  setText(el.vHdg, typeof p.heading_deg === 'number' ? pad(Math.round(p.heading_deg), 3) : '-');
  setText(el.vAlt, num(p.alt_m, 1));
  setText(el.vTilt, `${num(p.pitch_deg, 1)}°  ${num(p.roll_deg, 1)}°`);

  setText(el.vBattV, num(p.battery_v, 1));
  const pct = typeof p.battery_pct === 'number' ? Math.max(0, Math.min(100, p.battery_pct)) : null;
  el.battBar.style.width = pct == null ? '0%' : `${pct}%`;
  el.battBar.className = pct == null ? '' : (pct <= 20 ? 'crit' : pct <= 40 ? 'warn' : '');
  setText(el.vBattA, num(p.battery_a, 1));
  setText(el.vBattPct, pct == null ? '-' : `${Math.round(pct)}%`);

  setText(el.vFix, p.gps_fix || '-');
  setText(el.vSats, p.gps_sats == null ? '-' : String(p.gps_sats));
  setText(el.vHdop, num(p.gps_hdop, 2));

  setText(el.vWp, p.mission_wp_curr == null ? '-' : String(p.mission_wp_curr));
  setText(el.vWpD, p.mission_dist_m == null ? '-' : `${num(p.mission_dist_m, 0)} M`);
  setText(el.vHome, p.home_dist_m == null ? '-' : `${num(p.home_dist_m, 0)} M`);

  setText(el.vLat, typeof p.lat === 'number' ? p.lat.toFixed(6) : '-');
  setText(el.vLon, typeof p.lon === 'number' ? p.lon.toFixed(6) : '-');
  setText(el.vUtc, `${S.sel.day} ${hhmmss(wall)}Z`);
  setText(el.vSrc, `${S.sel.node} ${S.sel.cam}`);

  drawCompass(p.heading_deg);
  drawTilt(p.pitch_deg, p.roll_deg);
}

function fit(canvas) {
  const r = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(r.width * dpr));
  const h = Math.max(1, Math.round(r.height * dpr));
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.font = "12px 'JetBrains Mono','Cascadia Mono','Consolas',monospace";
  return { ctx, w: r.width, h: r.height };
}

const CARDINAL = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' };

function drawCompass(hdg) {
  const { ctx, w, h } = fit(el.compass);
  ctx.clearRect(0, 0, w, h);
  if (typeof hdg !== 'number') return;
  const pxPerDeg = w / 120;                       // 120 degrees across the tape
  ctx.strokeStyle = 'rgba(205,217,229,.25)';
  ctx.beginPath(); ctx.moveTo(0, h - 0.5); ctx.lineTo(w, h - 0.5); ctx.stroke();
  for (let d = -60; d <= 60; d += 5) {
    const deg = ((Math.round(hdg) + d) % 360 + 360) % 360;
    const x = w / 2 + d * pxPerDeg;
    const major = deg % 45 === 0;
    ctx.strokeStyle = major ? 'rgba(205,217,229,.75)' : 'rgba(205,217,229,.3)';
    ctx.beginPath();
    ctx.moveTo(x, h - (major ? 14 : 8));
    ctx.lineTo(x, h);
    ctx.stroke();
    if (major) {
      ctx.fillStyle = 'rgba(205,217,229,.75)';
      ctx.textAlign = 'center';
      ctx.fillText(CARDINAL[deg] || String(deg), x, h - 18);
    }
  }
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.moveTo(w / 2, h - 2); ctx.lineTo(w / 2 - 6, h - 12); ctx.lineTo(w / 2 + 6, h - 12);
  ctx.closePath(); ctx.fill();
  ctx.textAlign = 'center';
  ctx.fillText(pad(Math.round(hdg), 3), w / 2, 14);
}

function drawTilt(pitch, roll) {
  const { ctx, w, h } = fit(el.tilt);
  ctx.clearRect(0, 0, w, h);
  const p = typeof pitch === 'number' ? pitch : 0;
  const r = typeof roll === 'number' ? roll : 0;
  ctx.save();
  ctx.translate(w / 2, h / 2);
  ctx.rotate((-r * Math.PI) / 180);
  const off = Math.max(-h / 2, Math.min(h / 2, (p / 30) * (h / 2)));
  ctx.strokeStyle = typeof pitch === 'number' ? '#cdd9e5' : 'rgba(205,217,229,.25)';
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(-w / 2, off); ctx.lineTo(w / 2, off); ctx.stroke();
  ctx.strokeStyle = 'rgba(205,217,229,.3)';
  for (const d of [-20, -10, 10, 20]) {
    const y = off + (d / 30) * (h / 2);
    ctx.beginPath(); ctx.moveTo(-22, y); ctx.lineTo(22, y); ctx.stroke();
  }
  ctx.restore();
  ctx.strokeStyle = '#fff';
  ctx.beginPath();
  ctx.moveTo(w / 2 - 16, h / 2); ctx.lineTo(w / 2 - 5, h / 2);
  ctx.moveTo(w / 2 + 5, h / 2); ctx.lineTo(w / 2 + 16, h / 2);
  ctx.stroke();
}

/* --- timeline, map, graph ------------------------------------------------ */

function pickStep(spanMs) {
  const steps = [60e3, 300e3, 600e3, 1800e3, 3600e3, 7200e3, 21600e3];
  for (const s of steps) if (spanMs / s <= 12) return s;
  return steps[steps.length - 1];
}

function drawTimeline() {
  const { ctx, w, h } = fit(el.tlCanvas);
  ctx.clearRect(0, 0, w, h);
  if (!S.segments.length || !S.totalDur) return;
  ctx.fillStyle = 'rgba(0,0,0,.35)';
  ctx.fillRect(0, 0, w, h);

  for (const s of S.segments) {
    const x = (s.cum / S.totalDur) * w;
    ctx.fillStyle = 'rgba(205,217,229,.22)';
    ctx.fillRect(x, 8, Math.max(1, (s.dur / S.totalDur) * w), h - 20);
    if (s.disc) {                       // publisher reconnected: new time origin
      ctx.fillStyle = '#ff003c';
      ctx.fillRect(x, 4, 1.5, h - 12);
    }
  }
  if (S.clipIn != null && S.clipOut != null) {
    const a = (playbackAt(S.clipIn) / S.totalDur) * w;
    const b = (playbackAt(S.clipOut) / S.totalDur) * w;
    ctx.fillStyle = 'rgba(255,204,0,.22)';
    ctx.fillRect(Math.min(a, b), 8, Math.abs(b - a), h - 20);
  }
  for (const m of [S.clipIn, S.clipOut]) {
    if (m == null) continue;
    ctx.fillStyle = '#ffcc00';
    ctx.fillRect((playbackAt(m) / S.totalDur) * w - 1, 4, 2, h - 12);
  }
  ctx.fillStyle = 'rgba(205,217,229,.45)';
  const startWall = S.segments[0].start_ms;
  const endWall = wallAt(S.totalDur);
  const step = pickStep(endWall - startWall);
  for (let t = Math.ceil(startWall / step) * step; t <= endWall; t += step) {
    const x = (playbackAt(t) / S.totalDur) * w;
    ctx.fillRect(x, h - 9, 1, 4);
    ctx.textAlign = 'left';
    ctx.fillText(hhmmss(t).slice(0, 5), x + 3, h - 1);
  }
}

function drawMap(wall) {
  if (el.mapPanel.hidden) return;
  const { ctx, w, h } = fit(el.map);
  ctx.clearRect(0, 0, w, h);
  const pts = [];
  for (const s of S.telemetry) {
    const p = s.p || {};
    if (typeof p.lat === 'number' && typeof p.lon === 'number' && (p.lat || p.lon)) pts.push(p);
  }
  if (pts.length < 2) {
    ctx.fillStyle = 'rgba(205,217,229,.45)';
    ctx.fillText('NO POSITION DATA', 10, 20);
    el.mapCoord.textContent = '';
    return;
  }
  let minLa = Infinity, maxLa = -Infinity, minLo = Infinity, maxLo = -Infinity;
  for (const p of pts) {
    minLa = Math.min(minLa, p.lat); maxLa = Math.max(maxLa, p.lat);
    minLo = Math.min(minLo, p.lon); maxLo = Math.max(maxLo, p.lon);
  }
  // A degree of longitude shrinks with latitude; without this the track shape lies.
  const midLa = (minLa + maxLa) / 2, midLo = (minLo + maxLo) / 2;
  const kx = Math.cos((midLa * Math.PI) / 180) || 1;
  const sc = Math.min((w - 24) / Math.max((maxLo - minLo) * kx, 1e-6),
                      (h - 24) / Math.max(maxLa - minLa, 1e-6));
  const X = (lo) => w / 2 + (lo - midLo) * kx * sc;
  const Y = (la) => h / 2 - (la - midLa) * sc;

  ctx.strokeStyle = 'rgba(205,217,229,.5)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(X(p.lon), Y(p.lat)) : ctx.moveTo(X(p.lon), Y(p.lat))));
  ctx.stroke();

  const s = sampleAt(wall);
  if (s && s.p && typeof s.p.lat === 'number' && typeof s.p.lon === 'number') {
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(X(s.p.lon), Y(s.p.lat), 4, 0, Math.PI * 2); ctx.fill();
    el.mapCoord.textContent = `${s.p.lat.toFixed(5)} ${s.p.lon.toFixed(5)}`;
  } else {
    el.mapCoord.textContent = '';
  }
}

function drawGraph(wall) {
  const { ctx, w, h } = fit(el.graph);
  ctx.clearRect(0, 0, w, h);
  if (!S.segments.length) return;
  const t0 = S.segments[0].start_ms;
  const span = Math.max(1, wallAt(S.totalDur) - t0);
  const legend = [];
  for (const s of [
    { key: 'speed_kmh', color: '#00ff41', label: 'SPD' },
    { key: 'alt_m', color: '#00d4ff', label: 'ALT' },
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
  ctx.fillStyle = '#cdd9e5';
  ctx.fillRect(((wall - t0) / span) * w - 0.5, 0, 1, h);
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
      el.segNow.textContent = `${seg.path}   ${seg.par || ''}`;
      el.dlSeg.href = `/raw?path=${encodeURIComponent(seg.path)}&download=1`;
      el.dlSeg.hidden = false;
    }
    if (S.totalDur > 0) {
      el.tlHead.hidden = false;
      el.tlHead.style.left = `${(t / S.totalDur) * el.timeline.clientWidth}px`;
    }
    el.playBtn.innerHTML = el.video.paused ? '&#9654;' : '&#10073;&#10073;';
    renderOsd(wall);
    drawMap(wall);
    drawGraph(wall);
  }
  requestAnimationFrame(tick);
}

/* --- clip and export ----------------------------------------------------- */

function rangeSegments() {
  if (S.clipIn == null || S.clipOut == null || S.clipOut <= S.clipIn) return S.segments;
  return S.segments.filter(
    (s) => s.start_ms < S.clipOut && s.start_ms + s.dur * 1000 > S.clipIn);
}

/** First point where the video mode changes inside the range. A stream copy
 *  cannot join those, so the operator learns before starting a download. */
function modeChange() {
  const segs = rangeSegments();
  for (let i = 1; i < segs.length; i++) {
    if (segs[i].par && segs[i - 1].par && segs[i].par !== segs[i - 1].par) {
      return { at: segs[i].start_ms, from: segs[i - 1].par, to: segs[i].par };
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
  if (mc) q.set('reencode', '1');
  el.exportBtn.href = `/api/export?${q.toString()}`;
  el.exportBtn.textContent = mc ? `${label} (RE-ENCODE)` : label;
  el.exportBtn.classList.toggle('go', !mc);
  el.exportBtn.classList.toggle('blocked', !!mc);
  el.exportBtn.title = mc
    ? `Video mode changes at ${hhmmss(mc.at)} (${mc.from} -> ${mc.to}), so this range ` +
      `is re-encoded to one frame size. Slower than a plain copy.`
    : 'Stream copy, no quality loss';
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
const seekFromX = (clientX) => {
  const r = el.timeline.getBoundingClientRect();
  seekPlayback(Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * S.totalDur);
};

el.timeline.addEventListener('pointerdown', (e) => {
  if (!S.totalDur) return;
  S.scrubbing = true;
  el.timeline.setPointerCapture(e.pointerId);
  seekFromX(e.clientX);
});
el.timeline.addEventListener('pointermove', (e) => {
  const r = el.timeline.getBoundingClientRect();
  el.tlHover.hidden = false;
  el.tlHover.style.left = `${e.clientX - r.left}px`;
  if (S.totalDur) {
    el.timeline.title = hhmmss(wallAt(((e.clientX - r.left) / r.width) * S.totalDur));
  }
  if (S.scrubbing) seekFromX(e.clientX);
});
el.timeline.addEventListener('pointerup', (e) => {
  S.scrubbing = false;
  try { el.timeline.releasePointerCapture(e.pointerId); } catch { /* already released */ }
});
el.timeline.addEventListener('pointerleave', () => { el.tlHover.hidden = true; });

el.graph.addEventListener('click', (e) => {
  if (!S.segments.length) return;
  const r = el.graph.getBoundingClientRect();
  const t0 = S.segments[0].start_ms;
  const span = Math.max(1, wallAt(S.totalDur) - t0);
  seekPlayback(playbackAt(t0 + ((e.clientX - r.left) / r.width) * span));
});

const togglePlay = () => { el.video.paused ? el.video.play().catch(() => {}) : el.video.pause(); };
const setIn = () => { S.clipIn = wallAt(el.video.currentTime); updateExportLink(); };
const setOut = () => { S.clipOut = wallAt(el.video.currentTime); updateExportLink(); };
const jumpSegment = (dir) => {
  const s = segmentAt(el.video.currentTime);
  if (!s) return;
  seekPlayback(dir < 0 ? s.cum - 0.01 : s.cum + s.dur + 0.01);
};

el.playBtn.onclick = togglePlay;
el.prevBtn.onclick = () => jumpSegment(-1);
el.nextBtn.onclick = () => jumpSegment(1);
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
    case ' ': case 'k': e.preventDefault(); togglePlay(); break;
    case 'ArrowLeft': seekPlayback(v.currentTime - step); break;
    case 'ArrowRight': seekPlayback(v.currentTime + step); break;
    case '[': jumpSegment(-1); break;
    case ']': jumpSegment(1); break;
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
el.osd.hidden = true;
loadTree();
setInterval(loadTree, 60000);
requestAnimationFrame(tick);
