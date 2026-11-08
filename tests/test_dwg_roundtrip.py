"""A DWG goes in and a DWG comes out.

The real ODA File Converter is not installed on a development machine and is
not something a test should download, so a stand-in is put on the PATH that
honours its argument contract:

    ODAFileConverter "in folder" "out folder" version type recurse audit filter

That proves our half: that the right file is handed over, at the right
release, that the translated DXF is converted back, that a failure at the
last step does not lose the translation, and that a plain DXF job is
untouched by any of it. It proves nothing about the converter itself --
only a real drawing through a real converter does that.

    .venv/bin/python tests/test_dwg_roundtrip.py
"""
from __future__ import annotations

import io
import os
import tempfile
import time
from pathlib import Path
from urllib.parse import unquote

import ezdxf
from ezdxf.math import Vec2
from ezdxf.render import mleader

REPO = Path(__file__).resolve().parent.parent

STUB = r'''#!/bin/sh
# Stands in for the ODA File Converter:
#   ODAFileConverter "in folder" "out folder" version type recurse audit filter
IN="$1"; OUT="$2"; VER="$3"; TYPE="$4"; FILTER="$7"
STEM=$(basename "$FILTER" | sed 's/\.[^.]*$//')
echo "in=$IN out=$OUT ver=$VER type=$TYPE filter=$FILTER" >> "$STUB_LOG"
if [ "$STUB_FAIL" = "$TYPE" ]; then echo "stub: refusing to write $TYPE" >&2; exit 1; fi
if [ "$TYPE" = "DXF" ]; then
  cp "$STUB_DXF" "$OUT/$STEM.dxf"
else
  printf 'AC1024\000\000' > "$OUT/$STEM.dwg"
  cat "$IN/$FILTER" >> "$OUT/$STEM.dwg"
fi
exit 0
'''


def _stage(tmp: Path) -> tuple[bytes, bytes]:
    """A real DXF for the stub to hand back, and a stand-in DWG to upload."""
    doc = ezdxf.new("R2018", setup=True)
    msp = doc.modelspace()
    msp.add_text("ПЛАН ПЕРВОГО ЭТАЖА", dxfattribs={"height": 2.5, "insert": (0, 0)})
    msp.add_mtext("ВЕНТИЛЯЦИЯ\\PПРИТОЧНАЯ", dxfattribs={"char_height": 2.0, "insert": (0, 10)})
    b = msp.add_multileader_mtext("Standard")
    b.set_content("ТРУБА %%c100", char_height=2.0)
    b.add_leader_line(mleader.ConnectionSide.left, [Vec2(-10, 20)])
    b.build(insert=Vec2(0, 20))
    msp.add_line((0, 0), (100, 0))
    msp.add_circle((50, 50), 10)
    dxf = tmp / "real.dxf"
    doc.saveas(dxf)
    # Only the first six bytes decide which release wrote a DWG, and that is
    # all the app reads off it before handing the file to the converter.
    return dxf.read_bytes(), b"AC1024\x00\x00" + b"stand-in for a real DWG\n" * 500


def test_dwg_round_trip() -> None:
    tmp = Path(tempfile.mkdtemp(prefix="dxft-dwg-"))
    bin_dir = tmp / "bin"
    bin_dir.mkdir()
    stub = bin_dir / "ODAFileConverter"
    stub.write_text(STUB)
    stub.chmod(0o755)

    dxf_bytes, dwg_bytes = _stage(tmp)
    (tmp / "staged.dxf").write_bytes(dxf_bytes)
    os.environ["PATH"] = f"{bin_dir}{os.pathsep}{os.environ['PATH']}"
    os.environ["STUB_DXF"] = str(tmp / "staged.dxf")
    os.environ["STUB_LOG"] = str(tmp / "calls.log")
    os.environ.pop("STUB_FAIL", None)
    os.environ.setdefault("DXFT_WORKSPACES", str(REPO / "workspaces"))
    (tmp / "calls.log").write_text("")

    from fastapi.testclient import TestClient
    from dxft import web

    def fresh():
        web.ROOT = Path(tempfile.mkdtemp(prefix="dxft-dwg-jobs-", dir=tmp))
        web._running.clear()
        return TestClient(web.app)

    def wait(c, jid, limit=120):
        for _ in range(limit * 10):
            s = c.get(f"/api/jobs/{jid}").json()
            assert not s.get("error"), f"job failed: {str(s['error'])[:400]}"
            if not s.get("running"):
                return s
            time.sleep(0.1)
        raise AssertionError("still running")

    def upload(c, name="Планы ОВ.dwg", data=dwg_bytes):
        return c.post("/api/jobs",
                      files={"file": (name, io.BytesIO(data), "application/octet-stream")},
                      data={"source": "ru", "target": "en"})

    def run_all(c):
        r = upload(c)
        assert r.status_code == 200, r.text
        jid = r.json()["id"]
        assert r.json()["src_fmt"] == "dwg"
        wait(c, jid)
        assert c.post(f"/api/jobs/{jid}/translate?mode=mock").status_code == 200
        return jid, wait(c, jid)

    def dispo(r):
        return unquote(r.headers.get("content-disposition", ""))

    # ── the whole way through, and back out as a DWG ──
    c = fresh()
    jid, s = run_all(c)
    assert s["dl_ext"] == "dwg"
    pa = s["stages"]["patch"]
    assert pa["dwg_written"] is True
    assert pa["verified"] is True and not pa["problems"]
    # Read in at the newest release, written back out at the one it arrived as.
    calls = Path(os.environ["STUB_LOG"]).read_text().splitlines()
    assert "ver=ACAD2018 type=DXF filter=input.dwg" in calls[0], calls[0]
    assert "ver=ACAD2010 type=DWG filter=output.dxf" in calls[1], calls[1]

    r = c.get(f"/api/jobs/{jid}/download/output")
    assert r.status_code == 200 and ".dwg" in dispo(r), dispo(r)
    assert r.content[:6] == b"AC1024"
    r = c.get(f"/api/jobs/{jid}/download/output-dxf")
    assert r.status_code == 200 and ".dxf" in dispo(r), dispo(r)
    r = c.get(f"/api/jobs/{jid}/download/input")
    assert r.content == dwg_bytes, "the original is not what was uploaded"

    # ── re-reading must not convert it a second time ──
    before = len(Path(os.environ["STUB_LOG"]).read_text().splitlines())
    assert c.post(f"/api/jobs/{jid}/reread").status_code == 200
    wait(c, jid)
    after = len(Path(os.environ["STUB_LOG"]).read_text().splitlines())
    assert after == before, f"re-read converted again ({before} -> {after})"

    # ── a failure at the last step must not lose the translation ──
    os.environ["STUB_FAIL"] = "DWG"
    c = fresh()
    jid, s = run_all(c)
    pa = s["stages"]["patch"]
    assert pa["dwg_written"] is False and pa.get("dwg_error"), pa
    assert pa["verified"] is True, "the DXF should still be written and verified"
    assert s["dl_ext"] == "dxf"
    assert ".dxf" in dispo(c.get(f"/api/jobs/{jid}/download/output"))
    assert "could not be written" in c.get(f"/api/jobs/{jid}/download/report.md").text
    del os.environ["STUB_FAIL"]

    # ── no converter on this server ──
    saved = os.environ["PATH"]
    os.environ["PATH"] = "/usr/bin:/bin"
    r = upload(fresh())
    assert r.status_code == 400 and "ODA File Converter" in r.text, (r.status_code, r.text[:200])
    os.environ["PATH"] = saved

    # ── named .dwg but is not one ──
    r = upload(fresh(), name="not-really.dwg", data=b"this is not a DWG at all")
    assert r.status_code == 400 and "not a DWG" in r.text, (r.status_code, r.text[:200])

    # ── a plain DXF job is untouched by any of this ──
    c = fresh()
    r = upload(c, name="sheet.dxf", data=dxf_bytes)
    assert r.status_code == 200, r.text
    jid = r.json()["id"]
    s = wait(c, jid)
    assert s.get("src_fmt") is None and s["dl_ext"] == "dxf"
    assert not (web.ROOT / jid / "input.dwg").exists()
    c.post(f"/api/jobs/{jid}/translate?mode=mock")
    s = wait(c, jid)
    assert s["stages"]["patch"]["verified"] is True
    assert "dwg" not in dispo(c.get(f"/api/jobs/{jid}/download/output")).lower()


if __name__ == "__main__":
    test_dwg_round_trip()
    print("ok: DWG in, DWG out, and every way it can fail says so")
