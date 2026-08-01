# HELMDECK archive viewer - read-only web UI over the VPS archive.
#
# Reads (never writes) two directory trees produced by the existing receiver:
#   VIDEO_ROOT/.../<node>/<cam>/<YYYY-MM-DD_HH-MM-SS-ffffff>.ts   (MediaMTX MPEG-TS)
#   TELEM_ROOT/<node>/<session>.jsonl                             (sink NDJSON, {"t":ms,"p":{...}})
#
# Serves a browsable tree, a per-day VOD HLS playlist for seekable playback,
# the raw segments, a time-ranged telemetry feed for the synced OSD overlay,
# and an on-demand MP4 export. Everything else in the system is untouched.

import os
import re
import json
import time
import shlex
import threading
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import (
    FileResponse,
    JSONResponse,
    PlainTextResponse,
    StreamingResponse,
)
from fastapi.staticfiles import StaticFiles

VIDEO_ROOT = Path(os.environ.get("VIDEO_ROOT", "/archive/video")).resolve()
TELEM_ROOT = Path(os.environ.get("TELEM_ROOT", "/archive/telemetry")).resolve()
STATIC_DIR = Path(__file__).parent / "static"

MAX_TELEM_SPAN_MS = 24 * 3600 * 1000
MAX_TELEM_SAMPLES = 200_000
# A concat list longer than the 64 KiB pipe buffer is what turns the export into
# a deadlock; cap it well below that and tell the caller to narrow the range.
MAX_EXPORT_SEGMENTS = 2000
CLIP_TAIL_MARGIN_S = 1.0

# <YYYY-MM-DD_HH-MM-SS-ffffff>.ts  (MediaMTX %Y-%m-%d_%H-%M-%S-%f). Container TZ
# is UTC by default, matching the telemetry unix-ms clock; a UI offset control
# absorbs any residual skew.
SEG_RE = re.compile(r"(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})-(\d{6})\.ts$")

app = FastAPI(title="HELMDECK archive")


def seg_start_ms(name: str):
    m = SEG_RE.search(name)
    if not m:
        return None
    y, mo, d, h, mi, s, us = (int(x) for x in m.groups())
    dt = datetime(y, mo, d, h, mi, s, us, tzinfo=timezone.utc)
    return int(dt.timestamp() * 1000)


def _iso(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).isoformat().replace("+00:00", "Z")


def _ffprobe(path: str, entries: str):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", entries,
         "-of", "default=nw=1:nk=1", path],
        capture_output=True, text=True, timeout=30,
    )
    return out.stdout.strip()


# Keyed by (path, size, mtime): segments are immutable once written. Failures are
# deliberately NOT memoised - a transient one (ffprobe timeout under load, the
# file unlinked by diskring mid-probe) would otherwise pin that segment at 0.000
# for the process lifetime, and `cum` accumulates durations, so one poisoned
# segment shifts the timeline of every later segment that day.
_probe_cache: dict = {}


def _cached(key, fn, bad):
    if key in _probe_cache:
        return _probe_cache[key]
    try:
        val = fn()
    except Exception:
        return bad
    if len(_probe_cache) > 16384:
        _probe_cache.clear()
    _probe_cache[key] = val
    return val


def _probe(path: str, size: int, mtime: int) -> float:
    return _cached(("d", path, size, mtime),
                   lambda: float(_ffprobe(path, "format=duration")), 0.0)


def _codec(path: str, size: int, mtime: int) -> str:
    return _cached(("c", path, size, mtime),
                   lambda: _ffprobe(path, "stream=codec_name").split("\n")[0], "")


def _keyframe_offsets(path: str, size: int, mtime: int):
    """Keyframe positions in seconds from the START of this segment.

    Needed to cut a clip cleanly. Seeking is done on the OUTPUT side, because an
    input -ss across the concat demuxer seeks imprecisely and leaves a silent
    offset at the head of the file (measured: a 7 s clip came out 11 s long).
    Output -ss with -c copy simply drops packets, so it is exact - but it opens
    mid-GOP unless the cut lands exactly on a keyframe, which is what this gives
    us. Uses raw packet flags, so it needs no decoding.
    """
    def run():
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "v:0",
             "-show_entries", "packet=pts_time,flags", "-of", "csv=p=0", path],
            capture_output=True, text=True, timeout=60,
        )
        first, keys = None, []
        for line in out.stdout.splitlines():
            parts = line.strip().split(",")
            if len(parts) < 2:
                continue
            try:
                pts = float(parts[0])
            except ValueError:
                continue
            if first is None:
                first = pts
            if "K" in parts[1]:
                keys.append(pts - first)
        return sorted(k for k in keys if k >= 0)
    return _cached(("k", path, size, mtime), run, [])


def keyframes_of(p: Path):
    try:
        st = p.stat()
    except OSError:
        return []
    return _keyframe_offsets(str(p), st.st_size, int(st.st_mtime))


def duration(p: Path) -> float:
    # diskring can unlink a segment between the scan and this call.
    try:
        st = p.stat()
    except OSError:
        return 0.0
    return _probe(str(p), st.st_size, int(st.st_mtime))


def codec_of(p: Path) -> str:
    try:
        st = p.stat()
    except OSError:
        return ""
    return _codec(str(p), st.st_size, int(st.st_mtime))


def _safe_under(root: Path, p: Path) -> Path:
    rp = (root / p).resolve() if not p.is_absolute() else p.resolve()
    if root not in rp.parents and rp != root:
        raise HTTPException(status_code=400, detail="path escapes root")
    return rp


_scan_cache = {"t": 0.0, "v": None}
SCAN_TTL = 20.0


def scan_segments():
    """All video segments as (node, cam, day, start_ms, path), sorted by time.

    Walks the whole archive, so it is TTL-cached: the UI polls /api/tree every
    30 s per open tab, and at 30 d retention this is thousands of stat() calls
    per request on a host shared with other workloads.
    """
    now = time.monotonic()
    if _scan_cache["v"] is not None and now - _scan_cache["t"] < SCAN_TTL:
        return _scan_cache["v"]
    out = []
    if not VIDEO_ROOT.exists():
        return out
    for p in VIDEO_ROOT.rglob("*.ts"):
        st = seg_start_ms(p.name)
        if st is None:
            continue
        cam = p.parent.name
        node = p.parent.parent.name
        day = datetime.fromtimestamp(st / 1000, tz=timezone.utc).strftime("%Y-%m-%d")
        out.append((node, cam, day, st, p))
    out.sort(key=lambda r: r[3])
    _scan_cache.update(t=now, v=out)
    return out


@app.get("/api/tree")
def api_tree():
    tree = {}
    for node, cam, day, st, p in scan_segments():
        tree.setdefault(node, {}).setdefault(cam, {}).setdefault(day, 0)
        tree[node][cam][day] += 1
    # nodes -> cameras -> days [{day, segments}]
    result = []
    for node in sorted(tree):
        cams = []
        for cam in sorted(tree[node]):
            days = [{"day": d, "segments": tree[node][cam][d]} for d in sorted(tree[node][cam], reverse=True)]
            cams.append({"cam": cam, "days": days})
        result.append({"node": node, "cameras": cams})
    return {"nodes": result, "telemetry_nodes": sorted(_telem_nodes())}


def _day_segments(node: str, cam: str, day: str):
    segs = [r for r in scan_segments() if r[0] == node and r[1] == cam and r[2] == day]
    items, cum = [], 0.0
    for _n, _c, _d, st, p in segs:
        dur = duration(p)
        rel = p.relative_to(VIDEO_ROOT).as_posix()
        items.append({"start_ms": st, "dur": dur, "cum": cum, "path": rel})
        cum += dur
    return items


@app.get("/api/segments")
def api_segments(node: str, cam: str, day: str):
    items = _day_segments(node, cam, day)
    if not items:
        raise HTTPException(status_code=404, detail="no segments")
    return {"node": node, "cam": cam, "day": day, "segments": items,
            "total_dur": sum(i["dur"] for i in items),
            "start_ms": items[0]["start_ms"]}


@app.get("/api/hls")
def api_hls(node: str, cam: str, day: str):
    items = _day_segments(node, cam, day)
    if not items:
        raise HTTPException(status_code=404, detail="no segments")
    target = max((i["dur"] for i in items), default=10)
    lines = ["#EXTM3U", "#EXT-X-VERSION:3", "#EXT-X-PLAYLIST-TYPE:VOD",
             f"#EXT-X-TARGETDURATION:{int(target) + 1}", "#EXT-X-MEDIA-SEQUENCE:0"]
    prev_end = None
    for i in items:
        # MediaMTX closes the recorder and opens a NEW segment on every publisher
        # disconnect, and each publish session carries its own PCR/PTS origin.
        # Without an explicit discontinuity the player treats those as one
        # timeline and stalls or jumps at the seam - which is exactly what a
        # flapping uplink produces, all day long.
        if prev_end is not None and abs(i["start_ms"] - prev_end) > 500:
            lines.append("#EXT-X-DISCONTINUITY")
        lines.append(f"#EXT-X-PROGRAM-DATE-TIME:{_iso(i['start_ms'])}")
        lines.append(f"#EXTINF:{i['dur']:.3f},")
        lines.append(f"/seg?path={quote(i['path'])}")
        prev_end = i["start_ms"] + int(i["dur"] * 1000)
    lines.append("#EXT-X-ENDLIST")
    return PlainTextResponse("\n".join(lines) + "\n", media_type="application/vnd.apple.mpegurl")


@app.get("/seg")
def seg(path: str, download: int = 0):
    p = _safe_under(VIDEO_ROOT, Path(path))
    if not p.exists() or p.suffix != ".ts":
        raise HTTPException(status_code=404, detail="not found")
    headers = {}
    if download:
        headers["Content-Disposition"] = f'attachment; filename="{p.name}"'
    return FileResponse(str(p), media_type="video/mp2t", headers=headers)


def _telem_nodes():
    if not TELEM_ROOT.exists():
        return []
    return [d.name for d in TELEM_ROOT.iterdir() if d.is_dir()]


@app.get("/api/telemetry")
def api_telemetry(node: str, start: int = Query(...), end: int = Query(...)):
    """All telemetry samples for `node` with start <= t <= end, sorted by t.

    Bounded on both axes: telemetry is logged at ~10 Hz per node, so an unbounded
    range builds the whole history as one Python list and serialises it again as
    one JSON body. The UI asks for a +-35 s window, so these caps never bind on
    a legitimate request.
    """
    if end <= start or end - start > MAX_TELEM_SPAN_MS:
        raise HTTPException(status_code=400, detail="range must be 0 < span <= 24h")
    d = _safe_under(TELEM_ROOT, Path(node))
    samples = []
    if d.exists():
        for f in sorted(d.glob("*.jsonl")):
            try:
                with open(f, "r", encoding="utf-8", errors="ignore") as fh:
                    for line in fh:
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            rec = json.loads(line)
                        except Exception:
                            continue
                        t = rec.get("t")
                        if isinstance(t, (int, float)) and start <= t <= end:
                            samples.append({"t": int(t), "p": rec.get("p", {})})
                            if len(samples) >= MAX_TELEM_SAMPLES:
                                break
            except OSError:
                continue
            if len(samples) >= MAX_TELEM_SAMPLES:
                break
    samples.sort(key=lambda r: r["t"])
    return {"node": node, "count": len(samples), "samples": samples}


@app.get("/api/export")
def api_export(node: str, cam: str, day: str,
               start_ms: int | None = None, end_ms: int | None = None):
    """Stream a day (or, with start_ms/end_ms, a wall-clock CLIP) as one MP4.
    Always copy, no re-encode; clip cuts land on the nearest keyframe."""
    items = _day_segments(node, cam, day)
    if not items:
        raise HTTPException(status_code=404, detail="no segments")

    fn = f"{node}_{cam}_{day}.mp4"
    trim = []
    if start_ms is not None and end_ms is not None and end_ms > start_ms:
        # Keep only segments overlapping the requested wall-clock window.
        clip = [i for i in items
                if i["start_ms"] < end_ms and i["start_ms"] + i["dur"] * 1000 > start_ms]
        if not clip:
            raise HTTPException(status_code=404, detail="no segments in clip range")
        items = clip
        offset_s = max(0.0, (start_ms - items[0]["start_ms"]) / 1000.0)
        # Snap the cut back to the keyframe at or before it, so the clip opens on
        # an IDR instead of smearing until the next one. The extra lead-in is
        # added to the duration, so the clip still ENDS where the user asked.
        keys = [k for k in keyframes_of(VIDEO_ROOT / items[0]["path"]) if k <= offset_s]
        snapped = keys[-1] if keys else 0.0
        # Measured: with -c copy the tail lands about a second short of the
        # requested end, the same for -t, -to and -copyts, because the segment's
        # container start is not zero. Over-include rather than cut off the
        # moment the operator asked for.
        dur_s = (end_ms - start_ms) / 1000.0 + (offset_s - snapped) + CLIP_TAIL_MARGIN_S
        # Both are OUTPUT options on purpose: see _keyframe_offsets.
        trim = ["-ss", f"{snapped:.3f}", "-t", f"{dur_s:.3f}"]
        stamp = _iso(start_ms).replace(":", "-").replace("T", "_")[:19]
        fn = f"{node}_{cam}_{stamp}.mp4"

    # diskring may have removed a segment since the scan; a missing file makes
    # ffmpeg fail AFTER the 200 response is committed, i.e. a silently truncated
    # download. Drop them up front instead.
    items = [i for i in items if (VIDEO_ROOT / i["path"]).exists()]
    if not items:
        raise HTTPException(status_code=404, detail="segments no longer available")
    if len(items) > MAX_EXPORT_SEGMENTS:
        raise HTTPException(status_code=413, detail="too many segments; narrow the range")

    concat = "".join(
        "file {}\n".format(shlex.quote(str(VIDEO_ROOT / i["path"]))) for i in items
    ).encode("utf-8")
    # Tag HEVC as hvc1: ffmpeg defaults to hev1, which QuickTime, Safari and
    # Windows Media Player refuse - exactly the players someone reaches for when
    # their browser could not play HEVC in the first place.
    tag = ["-tag:v", "hvc1"] if codec_of(VIDEO_ROOT / items[0]["path"]) == "hevc" else []
    cmd = [
        "ffmpeg", "-hide_banner", "-loglevel", "error",
        "-f", "concat", "-safe", "0", "-protocol_whitelist", "file,pipe",
        "-i", "pipe:0", "-c", "copy", *tag, "-avoid_negative_ts", "make_zero",
        *trim,
        "-f", "mp4", "-movflags", "frag_keyframe+empty_moov+default_base_moof", "pipe:1",
    ]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE)

    # Feed stdin from a helper thread. Writing it inline blocks the request
    # worker forever once the list outgrows the pipe buffer: ffmpeg stops
    # draining stdin while it waits on a stdout nobody is reading yet.
    def feed():
        try:
            proc.stdin.write(concat)
        except (BrokenPipeError, OSError):
            pass
        finally:
            try:
                proc.stdin.close()
            except OSError:
                pass

    threading.Thread(target=feed, daemon=True).start()

    def gen():
        try:
            while True:
                chunk = proc.stdout.read(64 * 1024)
                if not chunk:
                    break
                yield chunk
        finally:
            try:
                proc.stdout.close()
            except OSError:
                pass
            # Never a bare wait(): a client that aborts mid-download leaves
            # ffmpeg alive, and this container has a pids_limit.
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()

    return StreamingResponse(gen(), media_type="video/mp4",
                             headers={"Content-Disposition": f'attachment; filename="{fn}"'})


@app.get("/api/health")
def health():
    return {"ok": True, "video_root": str(VIDEO_ROOT), "telem_root": str(TELEM_ROOT),
            "video_exists": VIDEO_ROOT.exists(), "telem_exists": TELEM_ROOT.exists()}


# Static SPA (index.html at /, assets under their paths). Mounted last so the
# API routes above win.
app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="static")
