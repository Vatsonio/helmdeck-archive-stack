# HELMDECK archive viewer - read-only web UI over the archive.
#
# Reads (never writes) two directory trees produced by the receiver:
#   VIDEO_ROOT/archive/<node>/<cam>/<YYYY-MM-DD_HH-MM-SS-ffffff>.{mp4,ts}
#   TELEM_ROOT/<node>/<session>.jsonl        (sink NDJSON, {"t":ms,"p":{...}})
#
# THE PLAYBACK CONTRACT, and why this file looks the way it does:
#
# The cameras are H.265. A browser can only play that through MSE as fragmented
# MP4 with an `hvc1` sample entry; HEVC inside MPEG-TS is not decodable there at
# all (hls.js answers stream type 0x24 with "Unsupported HEVC in M2TS found"),
# which is why every recording made while the receiver wrote MPEG-TS was
# unplayable in this viewer.
#
# So the recorder now writes fMP4, and this server exposes every segment as an
# HLS fMP4 pair regardless of what is on disk:
#   /init?path=..  the initialisation segment (ftyp+moov, carries hvcC)
#   /seg?path=..   the media segment (moof+mdat onwards)
# For an .mp4 segment both are plain byte slices, no ffmpeg involved. For a
# legacy .ts segment they are produced by an on-the-fly `-c copy` remux, which
# costs no quality and about half a second per ten seconds of video.

import json
import os
import re
import shlex
import subprocess
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import (
    FileResponse,
    PlainTextResponse,
    Response,
    StreamingResponse,
)
from fastapi.staticfiles import StaticFiles

VIDEO_ROOT = Path(os.environ.get("VIDEO_ROOT", "/archive/video")).resolve()
TELEM_ROOT = Path(os.environ.get("TELEM_ROOT", "/archive/telemetry")).resolve()
STATIC_DIR = Path(__file__).parent / "static"
FFMPEG = os.environ.get("FFMPEG", "ffmpeg")
FFPROBE = os.environ.get("FFPROBE", "ffprobe")

MAX_TELEM_SPAN_MS = 24 * 3600 * 1000
MAX_TELEM_SAMPLES = 200_000
# A concat list longer than the 64 KiB pipe buffer is what turns the export into
# a deadlock; cap it well below that and tell the caller to narrow the range.
MAX_EXPORT_SEGMENTS = 2000
CLIP_TAIL_MARGIN_S = 1.0
SCAN_TTL = 20.0
# Two segments are treated as continuous when the next one starts within this of
# the previous one's end. Anything larger is a publisher reconnect, i.e. a fresh
# timestamp origin, and the player must be told about it.
GAP_TOLERANCE_MS = 500

# <YYYY-MM-DD_HH-MM-SS-ffffff>.{mp4,ts} (MediaMTX %Y-%m-%d_%H-%M-%S-%f). The
# container clock is pinned to UTC, matching the telemetry unix-ms timeline.
SEG_RE = re.compile(
    r"(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})-(\d{6})\.(mp4|ts)$"
)

app = FastAPI(title="HELMDECK archive")


# --- time helpers ----------------------------------------------------------

def seg_start_ms(name: str):
    m = SEG_RE.search(name)
    if not m:
        return None
    y, mo, d, h, mi, s, us = (int(x) for x in m.groups()[:7])
    return int(datetime(y, mo, d, h, mi, s, us, tzinfo=timezone.utc).timestamp() * 1000)


def _iso(ms: int) -> str:
    return (
        datetime.fromtimestamp(ms / 1000, tz=timezone.utc)
        .isoformat()
        .replace("+00:00", "Z")
    )


# --- probing, cached by (path, size, mtime) --------------------------------
# Segments are immutable once written, so those three identify the content.
# Failures are deliberately NOT cached: a transient one (ffprobe timeout under
# load, the file unlinked by the disk ring mid-probe) would otherwise pin a
# segment at 0.000 for the process lifetime, and because `cum` accumulates
# durations, one poisoned segment shifts the timeline of every later one.

_probe_cache: dict = {}
_probe_lock = threading.Lock()


def _cached(key, fn, bad):
    with _probe_lock:
        if key in _probe_cache:
            return _probe_cache[key]
    try:
        val = fn()
    except Exception:
        return bad
    with _probe_lock:
        if len(_probe_cache) > 16384:
            _probe_cache.clear()
        _probe_cache[key] = val
    return val


def _stat_key(p: Path):
    st = p.stat()
    return (str(p), st.st_size, int(st.st_mtime))


EMPTY_META = {"dur": 0.0, "codec": "", "w": 0, "h": 0, "fps": 25.0}


def meta_of(p: Path) -> dict:
    """Duration and video parameters, from ONE ffprobe call per segment.

    Everything downstream needs some of this, and a walk of a month of
    recordings is thousands of segments, so it is deliberately not three
    separate probes.
    """
    try:
        key = _stat_key(p)
    except OSError:
        return EMPTY_META

    def run():
        out = subprocess.run(
            [FFPROBE, "-v", "error", "-select_streams", "v:0",
             "-show_entries", "format=duration:stream=codec_name,width,height,r_frame_rate",
             "-of", "json", key[0]],
            capture_output=True, text=True, timeout=60,
        )
        j = json.loads(out.stdout or "{}")
        st = (j.get("streams") or [{}])[0]
        num, _, den = (st.get("r_frame_rate") or "25/1").partition("/")
        try:
            fps = float(num) / float(den or 1)
        except (ValueError, ZeroDivisionError):
            fps = 25.0
        return {
            "dur": float((j.get("format") or {}).get("duration") or 0.0),
            "codec": st.get("codec_name") or "",
            "w": int(st.get("width") or 0),
            "h": int(st.get("height") or 0),
            "fps": round(fps, 3) if 1 <= fps <= 240 else 25.0,
        }

    return _cached(("m",) + key, run, EMPTY_META)


def duration(p: Path) -> float:
    return meta_of(p)["dur"]


def codec_of(p: Path) -> str:
    return meta_of(p)["codec"]


def params_of(p: Path) -> str:
    """`codec WxH`. Segments that differ here cannot be stream copied into one
    file: the concat demuxer accepts them and emits a broken result (measured:
    70 s of mixed 720p and 1080p came out as 8 minutes at 3.6 fps).
    """
    m = meta_of(p)
    return f"{m['codec']} {m['w']}x{m['h']}" if m["codec"] else ""


def keyframes_of(p: Path):
    """Keyframe offsets in seconds from the start of this segment.

    Used to snap a clip cut so it opens on an IDR instead of smearing. Reads
    packet flags only, so nothing is decoded.
    """
    try:
        key = _stat_key(p)
    except OSError:
        return []

    def run():
        out = subprocess.run(
            [FFPROBE, "-v", "error", "-select_streams", "v:0",
             "-show_entries", "packet=pts_time,flags", "-of", "csv=p=0", key[0]],
            capture_output=True, text=True, timeout=120,
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

    return _cached(("k",) + key, run, [])


# --- archive scan ----------------------------------------------------------

def _safe_under(root: Path, p: Path) -> Path:
    rp = (root / p).resolve() if not p.is_absolute() else p.resolve()
    if root not in rp.parents and rp != root:
        raise HTTPException(status_code=400, detail="path escapes root")
    return rp


_scan_cache = {"t": 0.0, "v": None}


def scan_segments():
    """All segments as (node, cam, day, start_ms, path), sorted by time.

    Walks the whole archive, so it is TTL-cached: the UI polls the tree, and at
    a month of retention this is thousands of stat() calls per request on a host
    shared with other workloads.
    """
    now = time.monotonic()
    if _scan_cache["v"] is not None and now - _scan_cache["t"] < SCAN_TTL:
        return _scan_cache["v"]
    out = []
    if VIDEO_ROOT.exists():
        for p in VIDEO_ROOT.rglob("*"):
            if not p.is_file():
                continue
            st = seg_start_ms(p.name)
            if st is None:
                continue
            day = datetime.fromtimestamp(st / 1000, tz=timezone.utc).strftime("%Y-%m-%d")
            out.append((p.parent.parent.name, p.parent.name, day, st, p))
        out.sort(key=lambda r: r[3])
    _scan_cache.update(t=now, v=out)
    return out


def _telem_nodes():
    if not TELEM_ROOT.exists():
        return []
    return sorted(d.name for d in TELEM_ROOT.iterdir() if d.is_dir())


def _day_segments(node: str, cam: str, day: str):
    """Segments of one node/cam/day with their cumulative playback offsets.

    `cum` is the position on the CONTINUOUS playback timeline, which is what the
    player seeks in; `start_ms` is wall clock, which is what telemetry is keyed
    by. They diverge across a recording gap, and both are needed.
    """
    segs = [r for r in scan_segments() if r[0] == node and r[1] == cam and r[2] == day]
    items, cum, prev_end = [], 0.0, None
    for _n, _c, _d, st, p in segs:
        m = meta_of(p)
        dur = m["dur"]
        items.append({
            "start_ms": st,
            "dur": dur,
            "cum": cum,
            "path": p.relative_to(VIDEO_ROOT).as_posix(),
            "disc": prev_end is not None and abs(st - prev_end) > GAP_TOLERANCE_MS,
            # The viewer needs this to warn BEFORE an export that cannot be
            # stream copied, rather than after a failed download.
            "par": f"{m['codec']} {m['w']}x{m['h']}" if m["codec"] else "",
        })
        cum += dur
        prev_end = st + int(dur * 1000)
    return items


# --- fMP4 slicing ----------------------------------------------------------

def _first_moof(buf: bytes) -> int:
    """Offset of the first `moof` box, i.e. the end of the init segment."""
    i = buf.find(b"moof")
    return i - 4 if i >= 4 else -1


def _remux_cmd(src: str, seconds: float | None = None):
    """TS -> fMP4, stream copy. `seconds` limits the read for a cheap init."""
    cmd = [FFMPEG, "-hide_banner", "-loglevel", "error", "-i", src]
    if seconds is not None:
        cmd += ["-t", f"{seconds:.2f}"]
    return cmd + [
        "-c", "copy", "-tag:v", "hvc1", "-an",
        "-movflags", "frag_keyframe+empty_moov+default_base_moof",
        "-f", "mp4", "pipe:1",
    ]


def _init_bytes(p: Path) -> bytes:
    """The initialisation segment for `p` (ftyp+moov, carrying hvcC)."""
    def run():
        if p.suffix == ".mp4":
            head = p.open("rb").read(1 << 20)
            off = _first_moof(head)
            if off <= 0:
                raise ValueError("no fragment boundary in the first MiB")
            return head[:off]
        # Legacy MPEG-TS: a short remux is enough, and it is byte-identical to
        # the init of the full remux (verified), so the media part splices onto
        # it cleanly.
        out = subprocess.run(_remux_cmd(str(p), seconds=0.1),
                             capture_output=True, timeout=120).stdout
        off = _first_moof(out)
        if off <= 0:
            raise ValueError("remux produced no fragment")
        return out[:off]

    return _cached(("i",) + _stat_key(p), run, b"")


def _media_stream(p: Path):
    """Yield the media segment (everything from the first `moof` on)."""
    if p.suffix == ".mp4":
        with p.open("rb") as fh:
            head = fh.read(1 << 20)
            off = _first_moof(head)
            if off < 0:
                return
            yield head[off:]
            while True:
                b = fh.read(256 * 1024)
                if not b:
                    return
                yield b
        return

    proc = subprocess.Popen(_remux_cmd(str(p)), stdout=subprocess.PIPE)
    try:
        # Buffer only until the first fragment boundary is found, then pass
        # everything through. Scanning rather than trusting a byte count keeps
        # this correct even if ffmpeg's init ever changes size.
        head, started = b"", False
        while not started:
            b = proc.stdout.read(64 * 1024)
            if not b:
                return
            head += b
            off = _first_moof(head)
            if off >= 0:
                started = True
                yield head[off:]
        while True:
            b = proc.stdout.read(256 * 1024)
            if not b:
                return
            yield b
    finally:
        try:
            proc.stdout.close()
        except OSError:
            pass
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()


# --- API -------------------------------------------------------------------

@app.get("/api/health")
def health():
    return {
        "ok": True,
        "video_root": str(VIDEO_ROOT),
        "telem_root": str(TELEM_ROOT),
        "video_exists": VIDEO_ROOT.exists(),
        "telem_exists": TELEM_ROOT.exists(),
        "segments": len(scan_segments()),
    }


@app.get("/api/tree")
def api_tree():
    tree: dict = {}
    for node, cam, day, _st, _p in scan_segments():
        tree.setdefault(node, {}).setdefault(cam, {}).setdefault(day, 0)
        tree[node][cam][day] += 1
    nodes = []
    for node in sorted(tree):
        cams = []
        for cam in sorted(tree[node]):
            days = [{"day": d, "segments": tree[node][cam][d]}
                    for d in sorted(tree[node][cam], reverse=True)]
            cams.append({"cam": cam, "days": days})
        nodes.append({"node": node, "cameras": cams})
    return {"nodes": nodes, "telemetry_nodes": _telem_nodes()}


@app.get("/api/segments")
def api_segments(node: str, cam: str, day: str):
    items = _day_segments(node, cam, day)
    if not items:
        raise HTTPException(status_code=404, detail="no segments")
    return {
        "node": node, "cam": cam, "day": day, "segments": items,
        "total_dur": sum(i["dur"] for i in items),
        "start_ms": items[0]["start_ms"],
        "codec": codec_of(VIDEO_ROOT / items[0]["path"]),
    }


@app.get("/api/hls")
def api_hls(node: str, cam: str, day: str):
    """VOD playlist of fMP4 segments.

    An EXT-X-MAP is emitted before every segment: each recording session has its
    own parameter sets and timescale, and a single shared init would be wrong the
    moment the camera reconnects. EXT-X-DISCONTINUITY marks those seams so the
    player does not treat two timestamp origins as one timeline.
    """
    items = _day_segments(node, cam, day)
    if not items:
        raise HTTPException(status_code=404, detail="no segments")
    target = max((i["dur"] for i in items), default=10)
    lines = [
        "#EXTM3U",
        "#EXT-X-VERSION:7",
        "#EXT-X-PLAYLIST-TYPE:VOD",
        f"#EXT-X-TARGETDURATION:{int(target) + 1}",
        "#EXT-X-MEDIA-SEQUENCE:0",
    ]
    for i in items:
        if i["disc"]:
            lines.append("#EXT-X-DISCONTINUITY")
        q = quote(i["path"])
        lines.append(f'#EXT-X-MAP:URI="/init?path={q}"')
        lines.append(f"#EXT-X-PROGRAM-DATE-TIME:{_iso(i['start_ms'])}")
        lines.append(f"#EXTINF:{i['dur']:.3f},")
        lines.append(f"/seg?path={q}")
    lines.append("#EXT-X-ENDLIST")
    return PlainTextResponse("\n".join(lines) + "\n",
                             media_type="application/vnd.apple.mpegurl")


def _segment_path(path: str) -> Path:
    p = _safe_under(VIDEO_ROOT, Path(path))
    if not p.exists() or seg_start_ms(p.name) is None:
        raise HTTPException(status_code=404, detail="not found")
    return p


@app.get("/init")
def init_segment(path: str):
    p = _segment_path(path)
    data = _init_bytes(p)
    if not data:
        raise HTTPException(status_code=500, detail="cannot build init segment")
    return Response(content=data, media_type="video/mp4",
                    headers={"Cache-Control": "public, max-age=3600"})


@app.get("/seg")
def seg(path: str):
    p = _segment_path(path)
    return StreamingResponse(_media_stream(p), media_type="video/mp4",
                             headers={"Cache-Control": "public, max-age=3600"})


@app.get("/raw")
def raw(path: str, download: int = 0):
    """The segment exactly as recorded, for download or external tooling."""
    p = _segment_path(path)
    headers = {}
    if download:
        headers["Content-Disposition"] = f'attachment; filename="{p.name}"'
    media = "video/mp4" if p.suffix == ".mp4" else "video/mp2t"
    return FileResponse(str(p), media_type=media, headers=headers)


@app.get("/api/telemetry")
def api_telemetry(node: str, start: int = Query(...), end: int = Query(...)):
    """Samples for `node` with start <= t <= end, sorted by t.

    Bounded on both axes: the log runs at ~10 Hz per node, so an unbounded range
    would build the whole history as one list and serialise it again as one
    body. The viewer asks for a window around the playhead, so these never bind
    on a legitimate request.
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
                        except ValueError:
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


MAX_REENCODE_SEGMENTS = 60


@app.get("/api/export")
def api_export(node: str, cam: str, day: str,
               start_ms: int | None = None, end_ms: int | None = None,
               reencode: int = 0):
    """Stream a day, or the wall-clock range between the clip points, as one MP4.

    Stream copy by default: no quality loss, no CPU. When the range spans a
    camera video-mode change the copy path is impossible (the concat demuxer
    accepts mismatched segments and emits a broken timeline), so the caller is
    told to retry with `reencode=1`, which normalises everything to the first
    segment's frame size through the concat FILTER.
    """
    items = _day_segments(node, cam, day)
    if not items:
        raise HTTPException(status_code=404, detail="no segments")

    fn = f"{node}_{cam}_{day}.mp4"
    trim, trim_exact = [], []
    if start_ms is not None and end_ms is not None and end_ms > start_ms:
        clip = [i for i in items
                if i["start_ms"] < end_ms and i["start_ms"] + i["dur"] * 1000 > start_ms]
        if not clip:
            raise HTTPException(status_code=404, detail="no segments in clip range")
        items = clip
        offset_s = max(0.0, (start_ms - items[0]["start_ms"]) / 1000.0)
        # Snap back to the keyframe at or before the cut so the clip opens on an
        # IDR; the extra lead-in is added to the duration so it still ENDS where
        # the user asked. Seeking on the input side is not usable here: across
        # the concat demuxer it lands imprecisely and leaves a silent offset at
        # the head (measured: a 7 s clip came out 11 s long).
        keys = [k for k in keyframes_of(VIDEO_ROOT / items[0]["path"]) if k <= offset_s]
        snapped = keys[-1] if keys else 0.0
        # With -c copy the tail lands about a second short of the requested end,
        # identically for -t, -to and -copyts, because the container start is not
        # zero. Over-include rather than cut off the moment asked for.
        dur_s = (end_ms - start_ms) / 1000.0 + (offset_s - snapped) + CLIP_TAIL_MARGIN_S
        trim = ["-ss", f"{snapped:.3f}", "-t", f"{dur_s:.3f}"]
        # Re-encoding can start on any frame, so it needs no keyframe snapping
        # and no tail margin: the cut is exact.
        trim_exact = ["-ss", f"{offset_s:.3f}", "-t", f"{(end_ms - start_ms) / 1000.0:.3f}"]
        stamp = _iso(start_ms).replace(":", "-").replace("T", "_")[:19]
        fn = f"{node}_{cam}_{stamp}.mp4"

    # The disk ring may have removed a segment since the scan. A missing file
    # makes ffmpeg fail AFTER the 200 is committed, i.e. a silently truncated
    # download, so drop them up front instead.
    items = [i for i in items if (VIDEO_ROOT / i["path"]).exists()]
    if not items:
        raise HTTPException(status_code=404, detail="segments no longer available")
    if len(items) > MAX_EXPORT_SEGMENTS:
        raise HTTPException(status_code=413, detail="too many segments; narrow the range")

    # Stream copy cannot join segments with different codec parameters, and the
    # camera's video mode is switchable mid-mission, so this really happens.
    # Refuse rather than hand back a file whose timeline is silently wrong.
    mixed = len({i["par"] for i in items if i["par"]}) > 1
    if mixed and not reencode:
        change = next((i for n, i in enumerate(items)
                       if n and i["par"] != items[n - 1]["par"]), items[-1])
        raise HTTPException(
            status_code=409,
            detail=(f"this range spans a video mode change at "
                    f"{_iso(change['start_ms'])}; retry with reencode=1 "
                    f"(slower, re-encodes to one frame size)"),
        )

    # hvc1 rather than ffmpeg's default hev1: QuickTime and Windows Media Player
    # reject hev1, and those are exactly the players someone reaches for when
    # their browser could not play HEVC in the first place.
    tag = ["-tag:v", "hvc1"] if items[0]["par"].startswith("hevc") else []
    concat = b""

    if reencode:
        if len(items) > MAX_REENCODE_SEGMENTS:
            raise HTTPException(
                status_code=413,
                detail=f"re-encoding is limited to {MAX_REENCODE_SEGMENTS} segments; "
                       f"narrow the clip range")
        first = meta_of(VIDEO_ROOT / items[0]["path"])
        w, h = first["w"] or 1920, first["h"] or 1080
        fps = first["fps"] or 25.0
        # The concat DEMUXER cannot join mismatched streams at all, so the
        # filter is the only option here; it scales every input to one size.
        chains = "".join(
            f"[{n}:v]scale={w}:{h}:force_original_aspect_ratio=decrease,"
            f"pad={w}:{h}:-1:-1,setsar=1,fps={fps}[v{n}];"
            for n in range(len(items))
        )
        graph = chains + "".join(f"[v{n}]" for n in range(len(items))) \
            + f"concat=n={len(items)}:v=1:a=0[out]"
        cmd = [FFMPEG, "-hide_banner", "-loglevel", "error"]
        for i in items:
            cmd += ["-i", str(VIDEO_ROOT / i["path"])]
        cmd += [
            "-filter_complex", graph, "-map", "[out]",
            "-c:v", "libx265", "-preset", "veryfast", "-crf", "23", *tag,
            *(trim_exact or trim), "-f", "mp4",
            "-movflags", "frag_keyframe+empty_moov+default_base_moof", "pipe:1",
        ]
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE)
    else:
        concat = "".join(
            "file {}\n".format(shlex.quote(str(VIDEO_ROOT / i["path"]))) for i in items
        ).encode("utf-8")
        cmd = [
            FFMPEG, "-hide_banner", "-loglevel", "error",
            "-f", "concat", "-safe", "0", "-protocol_whitelist", "file,pipe",
            "-i", "pipe:0", "-c", "copy", *tag, "-avoid_negative_ts", "make_zero", *trim,
            "-f", "mp4", "-movflags", "frag_keyframe+empty_moov+default_base_moof", "pipe:1",
        ]
        proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE)

        # Feed stdin from a helper thread: writing it inline blocks the request
        # worker forever once the list outgrows the pipe buffer, because ffmpeg
        # stops draining stdin while it waits on a stdout nobody is reading yet.
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
            # Never a bare wait(): a client that aborts mid-download would leave
            # ffmpeg alive, and this container has a pids limit.
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()

    return StreamingResponse(gen(), media_type="video/mp4",
                             headers={"Content-Disposition": f'attachment; filename="{fn}"'})


# Static SPA (index.html at /, assets under their paths). Mounted last so the
# API routes above win.
app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="static")
