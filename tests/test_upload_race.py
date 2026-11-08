"""Two uploads at once must not land in each other's job.

The page sends a whole chosen set at the same time, so this is the normal
case, not a rare one. Run it directly:

    .venv/bin/python tests/test_upload_race.py
"""
from __future__ import annotations

import concurrent.futures as cf
import io
import os
import tempfile
from pathlib import Path

import ezdxf

REPO = Path(__file__).resolve().parent.parent


def test_concurrent_uploads_keep_their_own_drawing() -> None:
    jobs = Path(tempfile.mkdtemp(prefix="dxft-race-"))
    os.environ.setdefault("DXFT_WORKSPACES", str(REPO / "workspaces"))

    from fastapi.testclient import TestClient
    from dxft import web

    web.ROOT = jobs
    client = TestClient(web.app)

    # Each drawing says its own name, so a swap is visible in the file itself.
    payloads = {}
    for i in range(6):
        tag = f"SHEET-{i}"
        doc = ezdxf.new("R2010")
        doc.modelspace().add_text(tag, dxfattribs={"height": 2.5})
        f = jobs / f"{tag}.dxf"
        doc.saveas(f)
        payloads[tag] = f.read_bytes()
        f.unlink()

    def post(item):
        name, data = item
        r = client.post("/api/jobs",
                        files={"file": (f"{name}.dxf", io.BytesIO(data), "application/octet-stream")},
                        data={"source": "ja", "target": "en"})
        r.raise_for_status()
        return name, r.json()["id"]

    with cf.ThreadPoolExecutor(max_workers=len(payloads)) as ex:
        results = list(ex.map(post, payloads.items()))

    for name, job_id in results:
        got = (jobs / job_id / "input.dxf").read_bytes()
        assert got == payloads[name], (
            f"job {job_id} was created as {name} but holds "
            f"{[n for n, d in payloads.items() if d == got] or ['another drawing']}"
        )

    # The copy each upload is written to first must not be left lying about.
    assert not list(jobs.glob("_upload*")), "an upload copy was left behind"


if __name__ == "__main__":
    test_concurrent_uploads_keep_their_own_drawing()
    print("ok: every job holds the drawing it was created from")
