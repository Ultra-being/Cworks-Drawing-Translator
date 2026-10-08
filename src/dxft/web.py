"""The web app: upload a DXF, watch it go through the stages, review the
translations, patch, download. One page, no build step.

    dxft serve            -> http://127.0.0.1:8765

Long steps (translate, patch, render) run in worker threads; the page polls
the job until they finish. Everything is a file under jobs/<id>/, so the
CLI and the web app can be used on the same job.
"""
from __future__ import annotations

import json
import shutil
import gc
import threading
import time
import traceback
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse

from . import pipeline as pipe
from .pipeline import Job, JOBS, Memory, pricing, cost_usd
from . import pdfdoc
from . import preview

STATIC = Path(__file__).resolve().parent / "static"
app = FastAPI(title="Cworks Drawing Translator")


# ───────────────────────────── login ─────────────────────────────
# DXFT_USERS="allan:secret,staff:other" turns on HTTP Basic auth for every
# request (the browser shows a login box). Unset = open, for local use.

import base64
import hmac
import os
import re

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import Response


def _users() -> dict[str, str]:
    """name:password pairs, separated by a newline or a comma.

    Commas came first and are a trap: a generated password very often has one
    in it, and splitting on commas cuts that password in half, so the sign-in
    fails with nothing to see. A value spread over several lines is read a
    line at a time instead, which is the safer way to write it. Only the first
    colon separates, so a password may contain those freely.

    The document translator was fixed on 6 October and this was not, which is
    exactly the sort of thing that bites a week later: a member of staff whose
    password had a comma in it simply could not get in here.
    """
    raw = os.environ.get("DXFT_USERS", "").strip().strip('"').strip("'")
    lines = [l for l in raw.splitlines() if l.strip()]
    pairs = lines if len(lines) > 1 else raw.split(",")
    out = {}
    for pair in pairs:
        if ":" in pair:
            u, p = pair.split(":", 1)
            out[u.strip()] = p.strip()
    return out


class BasicAuth(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        users = _users()
        if not users or request.url.path in ("/healthz", "/api/debug/fonts"):
            return await call_next(request)
        header = request.headers.get("authorization", "")
        ok = False
        if header.lower().startswith("basic "):
            try:
                u, p = base64.b64decode(header[6:]).decode("utf-8").split(":", 1)
                ok = u in users and hmac.compare_digest(users[u], p)
            except Exception:
                ok = False
        if not ok:
            return Response("Cworks Drawing Translator: sign in", status_code=401,
                            headers={"WWW-Authenticate": 'Basic realm="Cworks Drawing Translator"'})
        return await call_next(request)


app.add_middleware(BasicAuth)


@app.get("/api/debug/fonts")
def debug_fonts():
    """Open diagnostics: which fonts the preview renderer resolves (no user data)."""
    return preview.cjk_font_status()


@app.get("/healthz")
def healthz():
    """Open, so it can be checked from outside. It says how many logins were
    read, never who they are: the count alone settles whether a sign-in that
    will not work is a wrong password or a setting that never parsed, and
    "logins": 0 says plainly that the app is open to anyone."""
    # The machine as well, because "why is the server slower than a laptop"
    # cost an afternoon to answer and the answer was 2 GB of RAM against a
    # peak need of 1.1 GB. It is on the open endpoint on purpose: it names no
    # drawing, no customer and no login, and being able to read it without
    # signing in is what makes it useful when something is wrong.
    return {"ok": True, "version": os.environ.get("RENDER_GIT_COMMIT", "local")[:7],
            "logins": len(_users()), "machine": pipe.machine()}

_running: dict[str, dict] = {}   # job id -> {"step": ..., "error": ...}
_lock = threading.Lock()
# Drawing a sheet is the most expensive thing this app does: a 20 MB drawing
# costs the better part of a gigabyte, most of it building the picture rather
# than reading the file. Two at once is more than the box has, and the kernel
# does not politely refuse -- it kills the process, so every request in flight
# dies with a 500 and whatever stage was running is left frozen mid-job. One
# at a time; the second caller waits instead.
_render_lock = threading.Lock()
# Reading a drawing is the other expensive thing, and uploads arrive in a run.
_read_lock = threading.Lock()
ROOT = JOBS


def _root() -> Path:
    return ROOT


def _job(job_id: str) -> Job:
    if not (_root() / job_id / "job.json").exists():
        raise HTTPException(404, "no such job")
    return Job(job_id, _root())


def _state(job_id: str) -> dict:
    meta = _job(job_id).meta
    run = _running.get(job_id, {})
    meta["running"] = run.get("step")
    meta["error"] = run.get("error")
    # How long the current step has been going, so the page can say "4 min" and
    # stop looking identical to a step that died.
    meta["runningFor"] = int(time.time() - run["since"]) if run.get("step") and run.get("since") else None
    # How much of the work is done, when the step can count it. Translating
    # reports each batch as it lands; the other steps are one piece of work.
    meta["done"], meta["total"] = run.get("done"), run.get("total")
    meta["waiting"] = bool(run.get("waiting"))
    meta["phase"] = run.get("phase")
    return meta


def _background(job_id: str, step: str, fn, queued: bool = False) -> None:
    with _lock:
        if _running.get(job_id, {}).get("step"):
            raise HTTPException(409, f"job is busy: {_running[job_id]['step']}")
        _running[job_id] = {"step": step, "error": None, "since": time.time(), "waiting": queued}

    def run():
        try:
            if queued:
                # Reading a drawing costs the better part of a gigabyte for a
                # large one, and someone uploading a whole set starts them one
                # after another. Two at once is more than the box has, and the
                # kernel kills the process rather than refusing. One at a time;
                # the rest wait their turn and say so.
                _read_lock.acquire()
                r = _running.get(job_id)
                if r is not None:
                    r["waiting"], r["since"] = False, time.time()
            try:
                fn()
            finally:
                if queued:
                    _read_lock.release()
            _running[job_id] = {"step": None, "error": None}
        except Exception as ex:  # surfaced on the page, not lost in a log
            _running[job_id] = {"step": None, "error": f"{step}: {ex}\n{traceback.format_exc()[-800:]}"}

    threading.Thread(target=run, daemon=True).start()


# ───────────────────────────── pages ─────────────────────────────

@app.get("/", response_class=HTMLResponse)
def index():
    # never cache the page: every update must reach the browser on reload
    return HTMLResponse((STATIC / "index.html").read_text(encoding="utf-8"), headers={"Cache-Control": "no-store"})


# ───────────────────────────── jobs ─────────────────────────────

@app.get("/api/jobs")
def list_jobs():
    out = []
    for d in sorted(_root().glob("*/job.json"), key=lambda p: p.parent.name, reverse=True):
        try:
            m = json.loads(d.read_text(encoding="utf-8"))
        except Exception:
            continue
        r = _running.get(m["id"], {})
        m["running"] = r.get("step")
        m["runningFor"] = int(time.time() - r["since"]) if r.get("step") and r.get("since") else None
        out.append(m)
    return out


@app.post("/api/jobs")
def create_job(file: UploadFile = File(...), source: str = Form("auto"), target: str = Form("en"),
               client: str = Form(""), project: str = Form("")):
    if not file.filename or not file.filename.lower().endswith((".dxf", ".pdf")):
        raise HTTPException(400, "upload a .dxf (export DWG as DXF first) or a vector .pdf")
    tmp = _root() / ("_upload.pdf" if file.filename.lower().endswith(".pdf") else "_upload.dxf")
    tmp.parent.mkdir(parents=True, exist_ok=True)
    with tmp.open("wb") as f:
        shutil.copyfileobj(file.file, f)
    job = Job.create(str(tmp), source, target, name=file.filename, root=_root(), client=client, project=project)
    tmp.unlink(missing_ok=True)

    def prep():
        job.inventory()
        job.prepare()

    _background(job.id, "inventory", prep, queued=True)
    return _state(job.id)


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str):
    return _state(job_id)


@app.patch("/api/jobs/{job_id}")
async def update_job(job_id: str, body: dict):
    """Move a job to another client / project, or file it away as done."""
    job = _job(job_id)
    m = job.meta
    for k in ("client", "project", "name"):
        if body.get(k) is not None and str(body[k]).strip():
            m[k] = str(body[k]).strip()
    if "archived" in body:
        # Finished work should not crowd what is still in hand, but it is not
        # rubbish either: it keeps its folder and comes back to it.
        m["archived_at"] = time.strftime("%Y-%m-%dT%H:%M:%S") if body["archived"] else None
    # Marking one done by hand: the app can only see a download, and every
    # drawing finished before it started watching has no record either way.
    # Guessing which of those were collected would be worse than letting
    # somebody say.
    if "done" in body:
        m["downloaded_at"] = time.strftime("%Y-%m-%dT%H:%M:%S") if body["done"] else None
    job.meta = m
    job.save_meta()
    return _state(job_id)


@app.get("/api/spend")
def spend():
    """Token spend across all jobs, in USD and JPY, from each job's usage log."""
    import datetime as dt
    prices = pricing()
    jpy = float(prices.get("jpy_per_usd", 150))
    today = dt.date.today().isoformat()
    month = today[:7]
    tot = {"all": 0.0, "month": 0.0, "today": 0.0, "tokens_in": 0, "tokens_out": 0, "jobs": 0}
    per_job: dict[str, float] = {}
    for d in _root().glob("*/job.json"):
        try:
            m = json.loads(d.read_text(encoding="utf-8"))
        except Exception:
            continue
        for e in m.get("usage_log", []):
            usd = cost_usd(e, prices)
            tot["all"] += usd
            if e.get("at", "")[:7] == month:
                tot["month"] += usd
            if e.get("at", "")[:10] == today:
                tot["today"] += usd
            tot["tokens_in"] += int(e.get("input", 0) or 0) + int(e.get("cache_read", 0) or 0) + int(e.get("cache_write", 0) or 0)
            tot["tokens_out"] += int(e.get("output", 0) or 0)
            per_job[m["id"]] = per_job.get(m["id"], 0.0) + usd
    tot["jobs"] = len(per_job)
    return {"usd": tot, "jpy_per_usd": jpy, "jpy": {k: round(v * jpy) for k, v in tot.items() if k in ("all", "month", "today")},
            "per_job_jpy": {k: round(v * jpy) for k, v in per_job.items()}, "rates": prices.get("usd_per_million", {})}


@app.get("/guide", response_class=HTMLResponse)
def guide():
    return (STATIC / "guide.html").read_text(encoding="utf-8")


TRASH_DAYS = 14


def _trash() -> Path:
    return _root() / "_trash"


def _empty_old_trash() -> None:
    """Let go of what was thrown away a fortnight ago."""
    cutoff = time.time() - TRASH_DAYS * 86400
    for d in _trash().glob("*"):
        try:
            if d.is_dir() and d.stat().st_mtime < cutoff:
                shutil.rmtree(d, ignore_errors=True)
        except Exception:
            continue


@app.delete("/api/jobs/{job_id}")
def delete_job(job_id: str):
    """Put a job aside rather than destroy it.

    A job folder holds a translation that was paid for, and deleting was the
    one action here with nothing behind it -- a misplaced click and the work
    was gone. It goes to one side for a fortnight now, and can be had back
    until then.
    """
    job = _job(job_id)
    # A busy job used to be undeletable, which is backwards: a job left running
    # by a closed page is precisely the one somebody wants rid of, and refusing
    # left them with no way to remove it at all. The step is forgotten and the
    # folder put aside; a thread still working finds its folder gone and stops,
    # which is what was wanted.
    _running.pop(job_id, None)
    _trash().mkdir(parents=True, exist_ok=True)
    kept = _trash() / job_id
    shutil.rmtree(kept, ignore_errors=True)
    shutil.move(str(job.dir), str(kept))
    _running.pop(job_id, None)
    _empty_old_trash()
    return {"ok": True, "recoverable_for_days": TRASH_DAYS}


@app.post("/api/jobs/{job_id}/restore")
def restore_job(job_id: str):
    """Bring back a job that was put aside."""
    kept = _trash() / job_id
    if not (kept / "job.json").exists():
        raise HTTPException(404, "that job is not in the bin — it may have been there over a fortnight")
    back = _root() / job_id
    if back.exists():
        raise HTTPException(409, "a job with that name is already here")
    shutil.move(str(kept), str(back))
    return _state(job_id)


@app.get("/api/trash")
def list_trash():
    """What can still be had back, newest first."""
    out = []
    for d in sorted(_trash().glob("*/job.json"), key=lambda p: p.parent.name, reverse=True):
        try:
            m = json.loads(d.read_text(encoding="utf-8"))
        except Exception:
            continue
        m["deleted_days_ago"] = round((time.time() - d.parent.stat().st_mtime) / 86400, 1)
        out.append(m)
    return out


@app.post("/api/jobs/{job_id}/unstick")
def unstick(job_id: str):
    """Clear a step that is no longer running.

    A container restart mid-stage (a deploy, an out-of-memory kill) leaves the
    page polling a step nobody is working on. This drops that claim so the job
    can be run again from wherever it got to; the finished stages are on disk
    and are not touched.
    """
    _job(job_id)
    was = _running.pop(job_id, {}).get("step")
    return {"ok": True, "cleared": was}


@app.post("/api/jobs/{job_id}/reread")
def reread(job_id: str):
    """Read the drawing again and work out its spaces afresh, keeping the
    translations.

    Stages 1 and 2 are where a drawing's sheets, cell walls and clear space
    are worked out, and where a PDF's text is read off the page. When
    something improves there, a job translated earlier knows nothing of it --
    and re-uploading to get it means paying for the same drawing twice. This
    re-runs those two stages in place. Stage 3 is untouched, so what has
    already been translated stays translated, and the memory covers anything
    the new segmentation asks for.

    PDFs were refused here, for no reason that survives looking at it: both
    stages have always handled them. The refusal meant the only way to give a
    PDF job a better reading was to upload it again, which is the cost this
    whole endpoint exists to avoid.
    """
    job = _job(job_id)

    def run():
        job.inventory()
        job.prepare()

    _background(job_id, "inventory", run, queued=True)
    return _state(job_id)


@app.delete("/api/folders")
def delete_folder(client: str, project: str | None = None):
    """Delete a whole project, or a whole client, and every job filed under it.

    The translation memory is not touched: it belongs to a language pair, not to
    a client, and throwing away what has been approved would cost real money to
    learn again.
    """
    doomed = []
    for d in sorted(_root().glob("*/job.json")):
        try:
            m = json.loads(d.read_text(encoding="utf-8"))
        except Exception:
            continue
        if (m.get("client") or "Unfiled") != client:
            continue
        if project is not None and (m.get("project") or "General") != project:
            continue
        doomed.append(m["id"])

    busy = [j for j in doomed if _running.get(j, {}).get("step")]
    if busy:
        raise HTTPException(409, f"{len(busy)} job(s) still running; wait for them to finish")

    _trash().mkdir(parents=True, exist_ok=True)
    for job_id in doomed:
        kept = _trash() / job_id
        shutil.rmtree(kept, ignore_errors=True)
        try:            # aside, like a single delete: a whole folder is more to lose, not less
            shutil.move(str(_root() / job_id), str(kept))
        except Exception:
            shutil.rmtree(_root() / job_id, ignore_errors=True)
        _running.pop(job_id, None)
    _empty_old_trash()
    return {"ok": True, "deleted": len(doomed), "recoverable_for_days": TRASH_DAYS}


@app.post("/api/jobs/{job_id}/translate")
def translate(job_id: str, mode: str = "claude"):
    job = _job(job_id)
    if "prepare" not in job.meta["stages"]:
        raise HTTPException(400, "inventory not finished")

    def report(done: int, total: int, phase: str = "translate") -> None:
        r = _running.get(job_id)
        if r is not None:
            r["done"], r["total"], r["phase"] = done, total, phase

    def run():
        job.translate(mode, on_progress=report)
        job.approve_all_ok()
        r = _running.get(job_id)
        if r is not None:
            r.pop("done", None); r.pop("total", None); r.pop("phase", None)
        _running[job_id]["step"] = "patch"
        job.patch()              # write the drawing straight away; edits go in with Re-patch
        for p in job.dir.glob("preview_after*.png"):
            p.unlink()

    _background(job_id, "translate", run)
    return _state(job_id)


@app.get("/api/jobs/{job_id}/review")
def review(job_id: str):
    job = _job(job_id)
    if not (job.dir / "translations.json").exists():
        return []
    return job.review_table()


@app.patch("/api/jobs/{job_id}/segments/{seg_id}")
async def set_segment(job_id: str, seg_id: str, body: dict):
    job = _job(job_id)
    job.set_review(seg_id, text=body.get("text"), approved=body.get("approved"),
                   width_factor=float(body["width_factor"]) if body.get("width_factor") is not None else None,
                   revert=bool(body.get("revert")))
    return next((r for r in job.review_table() if r["id"] == seg_id), {})


@app.post("/api/jobs/{job_id}/flag")
def flag(job_id: str, body: dict):
    """Mark a page or sheet for whoever takes this drawing on, or clear it.

    The app flags what it can measure. A reviewer looking at the sheet sees
    what it cannot -- a label sitting over a door, a note that reads wrongly
    in English -- and that knowledge was being lost between the screen and
    whoever does the editing. A flag with a note carries it into the report.
    """
    job = _job(job_id)
    place = str(body.get("place") or "").strip()
    if not place:
        raise HTTPException(400, "which page?")
    m = job.meta
    flags = dict(m.get("flags") or {})
    note = str(body.get("note") or "").strip()
    if body.get("clear"):
        flags.pop(place, None)
    else:
        flags[place] = note
    m["flags"] = flags
    job.meta = m
    job.save_meta()
    return _state(job_id)


@app.post("/api/jobs/{job_id}/approve-all")
def approve_all(job_id: str):
    return {"approved": _job(job_id).approve_all_ok()}


@app.post("/api/jobs/{job_id}/patch")
def patch(job_id: str, learn: bool = False):
    job = _job(job_id)
    if not (job.dir / "translations.json").exists():
        raise HTTPException(400, "translate first")

    def run():
        job.patch(learn=learn)
        for p in job.dir.glob("preview_after*.png"):  # output changed: previews are stale
            p.unlink()

    _background(job_id, "patch", run)
    return _state(job_id)


@app.post("/api/jobs/{job_id}/remember")
def remember(job_id: str):
    return {"stored": _job(job_id).remember()}


@app.get("/api/jobs/{job_id}/download/{name}")
def download(job_id: str, name: str):
    job = _job(job_id)
    fmt = job.fmt
    if name not in ("output", "output-notes", "report.md", "input"):
        raise HTTPException(404)
    if name == "output-notes":
        # Built fresh on each download, so it carries the flags as they stand
        # and output.pdf is left exactly as it was verified.
        if fmt != "pdf":
            raise HTTPException(400, "notes can only be written into a PDF")
        if not job.output_path.exists():
            raise HTTPException(404, "not produced yet")
        notes, summary = job.notes_by_page()
        if not notes:
            raise HTTPException(400, "nothing is flagged on this job")
        marked = job.dir / "output_notes.pdf"
        pdfdoc.annotate(str(job.output_path), str(marked), notes, summary)
        return FileResponse(str(marked), filename=f"{Path(job.meta['name']).stem}_{job.meta['target'].upper()}_notes.pdf")
    p = {"output": job.output_path, "input": job.input_path, "report.md": job.dir / "report.md"}[name]
    if not p.exists():
        raise HTTPException(404, "not produced yet")
    stem = Path(job.meta["name"]).stem
    filename = {"output": f"{stem}_{job.meta['target'].upper()}.{fmt}", "report.md": f"{stem}_report.md", "input": job.meta["name"]}[name]
    if name in ("output", "output-notes"):
        # Taking the drawing away is what "done with it" actually means. The
        # patch stage only says a file was produced; this says somebody came
        # and collected it, which is the thing worth seeing in the list.
        m = job.meta
        m["downloaded_at"] = time.strftime("%Y-%m-%dT%H:%M:%S")
        job.meta = m
        job.save_meta()
    return FileResponse(str(p), filename=filename)


@app.get("/api/jobs/{job_id}/preview/{which}")
def preview_png(job_id: str, which: str, x0: float | None = None, y0: float | None = None,
                x1: float | None = None, y1: float | None = None, width: int = 4000, page: int = 1,
                layout: str | None = None):
    """PNG of the input (before) or output (after). Without a window: the
    text extent of the sheet. Rendering is synchronous; big sheets take a minute."""
    job = _job(job_id)
    src = job.input_path if which == "before" else job.output_path
    if not src.exists():
        raise HTTPException(404, "not produced yet")
    if job.fmt == "pdf":
        return _preview_pdf(job, src, which, page, x0, y0, x1, y1, width)
    window = None
    if None not in (x0, y0, x1, y1):
        window = (min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1))
    elif layout:
        window = None                 # the whole sheet, as it was plotted
    else:
        inv = job.dir / "inventory.json"
        if inv.exists():
            found = preview.sheets(inv)
            window = found[0] if len(found) == 1 else preview.text_extent(inv)
    # The key has to say which part of the drawing was drawn, not merely that
    # nobody zoomed. It used to read "overview" whenever no rectangle was
    # dragged, so a window worked out afresh -- after a re-read, say, when the
    # inventory and therefore the extent of the text has changed -- was served
    # the picture drawn for the old one. Before and After then showed two
    # different parts of the same drawing, which reads as geometry gone
    # missing and is the worst thing this app could appear to do.
    if window:
        tag = f"{int(window[0])}_{int(window[1])}_{int(window[2])}_{int(window[3])}_{width}"
    else:
        tag = "overview"
    if layout:
        tag = "L" + re.sub(r"[^0-9A-Za-z]+", "_", layout)[:48] + "_" + tag
    key = tag + "_" + _preview_version()
    png = job.dir / f"preview_{which}_{key}.png"
    if not png.exists():
        # Wait for the sheet in front, but not forever: clicking through the
        # sheets of a ten-sheet drawing must not queue ten renders deep.
        if not _render_lock.acquire(timeout=180):
            raise HTTPException(503, "another sheet is being drawn; try again in a moment")
        try:
            if not png.exists():      # drawn while this request waited its turn
                drawn = preview.render(src, png, window, width_px=width, layout=layout)
                (job.dir / f"preview_{which}_{key}.json").write_text(json.dumps(drawn))
        except MemoryError:
            raise HTTPException(507, "this sheet is too large to draw here")
        finally:
            _render_lock.release()
            gc.collect()
    headers = {}
    meta = job.dir / f"preview_{which}_{key}.json"
    if meta.exists():
        headers["X-Window"] = meta.read_text()
    headers["Cache-Control"] = "no-store"
    return FileResponse(str(png), media_type="image/png", headers=headers)


def _preview_version() -> str:
    """Previews are cached per deployed version: a renderer change redraws everything."""
    return "v" + os.environ.get("RENDER_GIT_COMMIT", "local")[:7]


def _preview_pdf(job: Job, src: Path, which: str, page: int, x0, y0, x1, y1, width: int):
    """PDF pages render directly. Windows arrive in 'up' coordinates (y negated),
    the same frame the inventory uses, and go back the same way."""
    import pymupdf
    doc = pymupdf.open(str(src))
    page = max(1, min(page, len(doc)))
    pg = doc[page - 1]
    if None not in (x0, y0, x1, y1):
        clip = pymupdf.Rect(min(x0, x1), -max(y0, y1), max(x0, x1), -min(y0, y1))
        key = f"p{page}_{int(clip.x0)}_{int(clip.y0)}_{int(clip.x1)}_{int(clip.y1)}_{width}_{_preview_version()}"
    else:
        clip = pg.rect
        key = f"p{page}_overview_{_preview_version()}"
    png = job.dir / f"preview_{which}_{key}.png"
    if not png.exists():
        zoom = width / max(clip.width, 1)
        pg.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), clip=clip, alpha=False).save(str(png))
    drawn = [clip.x0, -clip.y1, clip.x1, -clip.y0]
    return FileResponse(str(png), media_type="image/png", headers={"X-Window": json.dumps(drawn), "X-Pages": str(len(doc)), "Cache-Control": "no-store"})


HELP_MODEL = os.environ.get("DXFT_HELP_MODEL", "claude-sonnet-5")


def _diagnostics(job_id: str, with_text: bool = False) -> str:
    """What is actually true about this job, in plain text: the stages and what
    they found, anything that failed, and how the strings came out. No drawing
    text unless it is asked for -- a fault report should not carry a client's
    drawing around with it by default."""
    job = _job(job_id)
    m = job.meta
    run = _running.get(job_id, {})
    mc = pipe.machine()
    L = [f"app version: {os.environ.get('RENDER_GIT_COMMIT', 'local')[:7]}",
         f"machine: {mc.get('ram_mb')} MB RAM, {mc.get('cpus')} CPU, "
         f"most used so far {mc.get('peak_mb')} MB",
         f"job: {job_id}  file: {m.get('name')}  format: {m.get('fmt')}",
         f"languages: {m.get('source')} to {m.get('target')}",
         f"filed under: {m.get('client') or 'Unfiled'} / {m.get('project') or 'General'}",
         f"status: {m.get('status')}"]
    if run.get("step"):
        secs = int(time.time() - run["since"]) if run.get("since") else None
        L.append(f"running now: {run['step']}" + (f" for {secs}s" if secs is not None else ""))
    if run.get("error"):
        L.append(f"ERROR: {run['error']}")
    L.append("")
    L.append("stages:")
    for name in ("inventory", "prepare", "translate", "patch"):
        st = (m.get("stages") or {}).get(name)
        L.append(f"  {name}: " + (json.dumps({k: v for k, v in st.items() if k != 'usage'}, ensure_ascii=False)
                                  if st else "not run"))
    worst: list[dict] = []
    fit = job.dir / "fit.json"
    if fit.exists():
        try:
            rows = json.loads(fit.read_text(encoding="utf-8"))
            by_flag: dict[str, int] = {}
            for f in rows:
                by_flag[f.get("flag") or "ok"] = by_flag.get(f.get("flag") or "ok", 0) + 1
            L.append("")
            L.append(f"fit: {len(rows)} strings, {json.dumps(by_flag)}")
            worst = sorted((f for f in rows if f.get("flag") in ("overflow", "tight")),
                           key=lambda f: f.get("suggested_width_factor", 1.0))[:8]
            for f in worst:
                L.append(f"  {f['id']} {f['flag']} width_factor={f.get('suggested_width_factor')} "
                         f"lines={f.get('lines_used')}/{f.get('lines_available')} room_em={f.get('cap_em')}")
        except Exception as ex:
            L.append(f"fit.json unreadable: {ex!r}")
    if with_text:
        try:
            read = lambda f: json.loads((job.dir / f).read_text(encoding="utf-8"))
            segs = {s_["id"]: s_ for s_ in read("segments.json")["segments"]}
            trs = {t["id"]: t["target"] for t in read("translations.json")["translations"]}
            L.append("")
            L.append("strings that did not fit (source -> target):")
            for f in worst:
                L.append(f"  {f['id']}: {segs.get(f['id'], {}).get('plain', '')!r} -> {trs.get(f['id'], '')!r}")
        except Exception as ex:
            L.append(f"strings unavailable: {ex!r}")
    return "\n".join(L)


@app.get("/api/jobs/{job_id}/diagnostics")
def diagnostics(job_id: str, text: int = 0):
    return {"text": _diagnostics(job_id, with_text=bool(text))}


def _guides() -> str:
    """The two guide files, as one block of text for the help desk.

    HOW_TO_USE says how to drive the app; TROUBLESHOOTING is the diagnosis of
    every awkward drawing we have met, and it is what lets the help desk tell a
    fault in the tool apart from a drawing that was always like that. Adding to
    those files is how the help desk is taught something new: no deploy, no code.

    They are looked for in several places because the app runs two ways. From a
    checkout they sit beside src/. Installed in the container the package lives
    in site-packages, nowhere near the repository root, so the Dockerfile copies
    them to /app and DXFT_GUIDES points here. Without this the help desk ran
    with no guide at all and nobody could tell from the outside.
    """
    here = Path(__file__).resolve()
    seen, out = set(), ""
    for name in ("HOW_TO_USE.md", "TROUBLESHOOTING.md"):
        for base in (os.environ.get("DXFT_GUIDES"), here.parents[2], here.parent, Path.cwd()):
            if not base:
                continue
            p_ = Path(base) / name
            if p_.exists() and p_ not in seen:
                seen.add(p_)
                out += f"\n\n===== {name} =====\n" + p_.read_text(encoding="utf-8")
                break
    return out


HELP_SYSTEM = """You are the help desk inside the Cworks Drawing Translator, a tool that
translates the text of construction drawings (DXF and vector PDF) between Japanese, Russian
and English without altering any geometry. You are talking to the person using it -- an
engineer or a member of staff, not a programmer.

Answer from the guide below and from the job's diagnostics. Be short and concrete: say what
to click and what to expect. Use the job's actual numbers when they answer the question.

Before saying anything is wrong with the output, work out whether the drawing was already
like that. The troubleshooting guide explains how, and tells you which complaints are
normally the drawing rather than the tool. Saying "check the Before preview at the same
spot" is often the whole answer, and it is a better answer than a guess.

What you must be straight about:
- You cannot change the app or fix faults in it. If something is a fault in the tool rather
  than a misunderstanding, say so plainly and tell them to use "Report a problem", which
  packages these diagnostics for the developer.
- A stage that is running is usually just slow, not stuck. Translating a large sheet takes
  several minutes and drawing a preview of a big drawing takes a minute or two per sheet.
  Use the elapsed time in the diagnostics before calling anything stuck.
- Never invent a button, a setting or a number. If the diagnostics do not say, say you
  cannot tell from here.
- You do not see the drawing's text unless it appears in the diagnostics, so do not guess
  at translation wording.

THE GUIDE:
"""


@app.post("/api/jobs/{job_id}/help")
def help_chat(job_id: str, body: dict):
    """A question about this job, answered with the job's own diagnostics to hand."""
    question = str(body.get("question") or "").strip()
    if not question:
        raise HTTPException(400, "ask a question")
    from .translate import ClaudeTranslator
    # Two files, and the order matters. HOW_TO_USE says how to drive the app;
    # TROUBLESHOOTING is the diagnosis of every awkward drawing we have met, and
    # it is what lets the help desk tell a fault in the tool apart from a drawing
    # that was always like that. Adding to those files is how the help desk is
    # taught something new -- it needs no deploy and no code change.
    guide = _guides()
    system = HELP_SYSTEM + guide + "\n\nTHIS JOB RIGHT NOW:\n" + _diagnostics(job_id)
    history = [h for h in (body.get("history") or []) if isinstance(h, dict)][-6:]
    convo = "".join(f"{h.get('role')}: {h.get('text')}\n" for h in history)
    try:
        t = ClaudeTranslator(HELP_MODEL)
        answer = t._call(system, convo + "user: " + question)
    except Exception as ex:
        raise HTTPException(502, f"could not reach the model: {ex}")
    job = _job(job_id)
    m = job.meta
    m.setdefault("usage_log", []).append({"at": time.strftime("%Y-%m-%dT%H:%M:%S"), "model": HELP_MODEL,
                                          "segments": 0, "help": True, **t.usage})
    job.meta = m
    job.save_meta()
    return {"answer": answer}


@app.get("/api/jobs/{job_id}/sheets")
def sheets(job_id: str):
    """Windows for the separate sheets found in a DXF model space (1 = whole drawing)."""
    job = _job(job_id)
    if job.fmt == "pdf":
        return {"sheets": [], "pages": (job.meta.get("stages", {}).get("inventory") or {}).get("pages", 1)}
    inv = job.dir / "inventory.json"
    if not inv.exists():
        return {"sheets": []}
    # A job taken before the drawing's own sheet borders were read has no
    # record of them. Read them now rather than making someone translate the
    # drawing again for a picture.
    data = json.loads(inv.read_text(encoding="utf-8"))
    if ("frames" not in data or "layouts" not in data) and job.input_path.exists():
        try:
            from . import inventory as invmod
            doc, _ = invmod.load(str(job.input_path))
            data.setdefault("frames", invmod.sheet_frames(doc))
            data.setdefault("layouts", invmod.paper_layouts(doc))
        except Exception:
            data.setdefault("frames", [])
            data.setdefault("layouts", [])
        inv.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    # A drawing with paper layouts has already been laid out into sheets by
    # whoever drew it. Nothing inferred from model space can better that.
    layouts = data.get("layouts") or []
    if layouts:
        return {"sheets": [], "layouts": layouts, "labels": layouts, "exact": True}

    found = preview.sheets(inv)
    # Sheets read from the drawing's own borders are exact and worth opening
    # on; sheets inferred from where the text falls are a guess, and a guess
    # must not take the whole drawing away from the reader.
    return {"sheets": found, "layouts": [], "exact": bool(getattr(preview.sheets, "from_frames", False)),
            "labels": list(getattr(preview.sheets, "labels", []) or [])}


@app.get("/api/memory/{source}/{target}")
def memory(source: str, target: str):
    return Memory(_root(), source, target).data


def serve(host: str = "127.0.0.1", port: int = 8765, jobs_root: Path | None = None) -> None:
    global ROOT
    if jobs_root is not None:
        ROOT = Path(jobs_root).resolve()
    ROOT.mkdir(parents=True, exist_ok=True)
    import uvicorn
    uvicorn.run(app, host=host, port=port, log_level="warning")
