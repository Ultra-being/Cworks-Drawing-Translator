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

from .pipeline import Job, JOBS, Memory
from . import preview

STATIC = Path(__file__).resolve().parent / "static"
app = FastAPI(title="Cworks Drawing Translator")

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
    return (STATIC / "index.html").read_text(encoding="utf-8")


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
def create_job(file: UploadFile = File(...), source: str = Form("auto"), target: str = Form("en")):
    if not file.filename or not file.filename.lower().endswith(".dxf"):
        raise HTTPException(400, "upload a .dxf file (export DWG as DXF first)")
    tmp = _root() / "_upload.dxf"
    tmp.parent.mkdir(parents=True, exist_ok=True)
    with tmp.open("wb") as f:
        shutil.copyfileobj(file.file, f)
    job = Job.create(str(tmp), source, target, name=file.filename, root=_root())
    tmp.unlink(missing_ok=True)

    def prep():
        job.inventory()
        job.prepare()

    _background(job.id, "inventory", prep)
    return _state(job.id)


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str):
    return _state(job_id)


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
    if name not in ("output.dxf", "report.md", "input.dxf"):
        raise HTTPException(404)
    p = job.dir / name
    if not p.exists():
        raise HTTPException(404, "not produced yet")
    stem = Path(job.meta["name"]).stem
    filename = {"output.dxf": f"{stem}_{job.meta['target'].upper()}.dxf", "report.md": f"{stem}_report.md", "input.dxf": job.meta["name"]}[name]
    return FileResponse(str(p), filename=filename)


@app.get("/api/jobs/{job_id}/preview/{which}")
def preview_png(job_id: str, which: str, x0: float | None = None, y0: float | None = None,
                x1: float | None = None, y1: float | None = None, width: int = 4000):
    """PNG of the input (before) or output (after). Without a window: the
    text extent of the sheet. Rendering is synchronous; big sheets take a minute."""
    job = _job(job_id)
    src = job.dir / ("input.dxf" if which == "before" else "output.dxf")
    if not src.exists():
        raise HTTPException(404, "not produced yet")
    window = None
    if None not in (x0, y0, x1, y1):
        window = (min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1))
    else:
        inv = job.dir / "inventory.json"
        if inv.exists():
            window = preview.text_extent(inv)
    key = "overview" if (x0 is None) else f"{int(window[0])}_{int(window[1])}_{int(window[2])}_{int(window[3])}_{width}"
    png = job.dir / f"preview_{which}_{key}.png"
    if not png.exists():
        drawn = preview.render(src, png, window, width_px=width)
        (job.dir / f"preview_{which}_{key}.json").write_text(json.dumps(drawn))
    headers = {}
    meta = job.dir / f"preview_{which}_{key}.json"
    if meta.exists():
        headers["X-Window"] = meta.read_text()
    return FileResponse(str(png), media_type="image/png", headers=headers)


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
