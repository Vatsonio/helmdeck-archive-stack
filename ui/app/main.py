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
import bisect
import subprocess
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path

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


@lru_cache(maxsize=8192)
def _probe(path: str, size: int, mtime: int) -> float:
    # Cached by (path, size, mtime): segments are immutable once written.
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=nw=1:nk=1", path],
            capture_output=True, text=True, timeout=30,
        )
        return float(out.stdout.strip())
    except Exception:
        return 0.0


def duration(p: Path) -> float:
    st = p.stat()
    return _probe(str(p), st.st_size, int(st.st_mtime))


def _safe_under(root: Path, p: Path) -> Path:
    rp = (root / p).resolve() if not p.is_absolute() else p.resolve()
    if root not in rp.parents and rp != root:
        raise HTTPException(status_code=400, detail="path escapes root")
    return rp


def scan_segments():
    """All video segments as (node, cam, day, start_ms, path), sorted by time."""
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
    for i in items:
        lines.append(f"#EXT-X-PROGRAM-DATE-TIME:{_iso(i['start_ms'])}")
        lines.append(f"#EXTINF:{i['dur']:.3f},")
        lines.append(f"/seg?path={i['path']}")
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
    """All telemetry samples for `node` with start <= t <= end, sorted by t."""
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
            except OSError:
                continue
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
    trim = []  # extra ffmpeg output opts for a clip
    if start_ms is not None and end_ms is not None and end_ms > start_ms:
        # Keep only segments overlapping the requested wall-clock window.
        clip = [i for i in items
                if i["start_ms"] < end_ms and i["start_ms"] + i["dur"] * 1000 > start_ms]
        if not clip:
            raise HTTPException(status_code=404, detail="no segments in clip range")
        items = clip
        offset_s = max(0.0, (start_ms - items[0]["start_ms"]) / 1000.0)
        dur_s = (end_ms - start_ms) / 1000.0
        trim = ["-ss", f"{offset_s:.3f}", "-t", f"{dur_s:.3f}",
                "-avoid_negative_ts", "make_zero"]
        stamp = _iso(start_ms).replace(":", "-").replace("T", "_")[:19]
        fn = f"{node}_{cam}_{stamp}.mp4"

    concat = "".join(
        f"file '{(VIDEO_ROOT / i['path'])}'\n" for i in items
    ).encode("utf-8")
    # Feed the concat list on stdin (pipe:0) via the concat demuxer.
    cmd = [
        "ffmpeg", "-hide_banner", "-loglevel", "error",
        "-f", "concat", "-safe", "0", "-protocol_whitelist", "file,pipe",
        "-i", "pipe:0", "-c", "copy", *trim,
        "-f", "mp4", "-movflags", "frag_keyframe+empty_moov+default_base_moof", "pipe:1",
    ]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE)
    proc.stdin.write(concat)
    proc.stdin.close()

    def gen():
        try:
            while True:
                chunk = proc.stdout.read(64 * 1024)
                if not chunk:
                    break
                yield chunk
        finally:
            proc.stdout.close()
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
