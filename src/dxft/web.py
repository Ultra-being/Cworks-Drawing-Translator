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
import threading
import traceback
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse

from .pipeline import Job, JOBS, Memory, pricing, cost_usd
from . import preview

STATIC = Path(__file__).resolve().parent / "static"
app = FastAPI(title="Cworks Drawing Translator")


# ───────────────────────────── login ─────────────────────────────
# DXFT_USERS="allan:secret,staff:other" turns on HTTP Basic auth for every
# request (the browser shows a login box). Unset = open, for local use.

import base64
import hmac
import os

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import Response


def _users() -> dict[str, str]:
    raw = os.environ.get("DXFT_USERS", "").strip()
    out = {}
    for pair in raw.split(","):
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
    return {"ok": True, "version": os.environ.get("RENDER_GIT_COMMIT", "local")[:7]}

_running: dict[str, dict] = {}   # job id -> {"step": ..., "error": ...}
_lock = threading.Lock()
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
    return meta


def _background(job_id: str, step: str, fn) -> None:
    with _lock:
        if _running.get(job_id, {}).get("step"):
            raise HTTPException(409, f"job is busy: {_running[job_id]['step']}")
        _running[job_id] = {"step": step, "error": None}

    def run():
        try:
            fn()
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
        m["running"] = _running.get(m["id"], {}).get("step")
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

    _background(job.id, "inventory", prep)
    return _state(job.id)


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str):
    return _state(job_id)


@app.patch("/api/jobs/{job_id}")
async def update_job(job_id: str, body: dict):
    """Move a job to another client / project (folders in the sidebar)."""
    job = _job(job_id)
    m = job.meta
    for k in ("client", "project", "name"):
        if body.get(k) is not None and str(body[k]).strip():
            m[k] = str(body[k]).strip()
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


@app.delete("/api/jobs/{job_id}")
def delete_job(job_id: str):
    job = _job(job_id)
    if _running.get(job_id, {}).get("step"):
        raise HTTPException(409, "job is busy")
    shutil.rmtree(job.dir)
    _running.pop(job_id, None)
    return {"ok": True}


@app.post("/api/jobs/{job_id}/translate")
def translate(job_id: str, mode: str = "claude"):
    job = _job(job_id)
    if "prepare" not in job.meta["stages"]:
        raise HTTPException(400, "inventory not finished")

    def run():
        job.translate(mode)
        job.approve_all_ok()
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
    if name not in ("output", "report.md", "input"):
        raise HTTPException(404)
    p = {"output": job.output_path, "input": job.input_path, "report.md": job.dir / "report.md"}[name]
    if not p.exists():
        raise HTTPException(404, "not produced yet")
    stem = Path(job.meta["name"]).stem
    filename = {"output": f"{stem}_{job.meta['target'].upper()}.{fmt}", "report.md": f"{stem}_report.md", "input": job.meta["name"]}[name]
    return FileResponse(str(p), filename=filename)


@app.get("/api/jobs/{job_id}/preview/{which}")
def preview_png(job_id: str, which: str, x0: float | None = None, y0: float | None = None,
                x1: float | None = None, y1: float | None = None, width: int = 4000, page: int = 1):
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
    else:
        inv = job.dir / "inventory.json"
        if inv.exists():
            found = preview.sheets(inv)
            window = found[0] if len(found) == 1 else preview.text_extent(inv)
    key = ("overview" if (x0 is None) else f"{int(window[0])}_{int(window[1])}_{int(window[2])}_{int(window[3])}_{width}") + "_" + _preview_version()
    png = job.dir / f"preview_{which}_{key}.png"
    if not png.exists():
        drawn = preview.render(src, png, window, width_px=width)
        (job.dir / f"preview_{which}_{key}.json").write_text(json.dumps(drawn))
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


@app.get("/api/jobs/{job_id}/sheets")
def sheets(job_id: str):
    """Windows for the separate sheets found in a DXF model space (1 = whole drawing)."""
    job = _job(job_id)
    if job.fmt == "pdf":
        return {"sheets": [], "pages": (job.meta.get("stages", {}).get("inventory") or {}).get("pages", 1)}
    inv = job.dir / "inventory.json"
    if not inv.exists():
        return {"sheets": []}
    return {"sheets": preview.sheets(inv)}


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
