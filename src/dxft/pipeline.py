"""The job runner. One folder per drawing, one JSON file per stage, so every
step is inspectable and any step can be re-run or hand-edited.

jobs/<id>/
  input.dxf          the file as uploaded
  job.json           settings + status
  inventory.json     stage 1
  segments.json      stage 2 (unique strings with markers)
  translations.json  stage 3 (model output, marker-checked)
  fit.json           stage 4
  review.json        stage 5: what the human approved (id -> text); edits win
  output.dxf         stage 6
  report.md          stage 7
"""
from __future__ import annotations

import json
import shutil
import time
import uuid
from dataclasses import asdict
from pathlib import Path

from . import inventory as inv
from . import prepare as prep
from . import translate as tr
from . import fit as fitmod
from . import patch as pt

JOBS = Path("jobs")


class Memory:
    """Exact-match translation memory per language pair: every approved
    translation is remembered, and the next sheet of the same set reuses it
    without asking the model. Title blocks, legends and repeated labels come
    out identical on every sheet, and cost nothing."""

    def __init__(self, root: Path, source: str, target: str):
        self.path = root / "_memory" / f"{source}-{target}.json"
        self.data: dict[str, str] = _r(self.path) if self.path.exists() else {}

    def get(self, source_text: str) -> str | None:
        return self.data.get(source_text)

    def learn(self, pairs: dict[str, str]) -> int:
        n = 0
        for k, v in pairs.items():
            if v.strip() and self.data.get(k) != v:
                self.data[k] = v
                n += 1
        if n:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            _w(self.path, self.data)
        return n


def _w(path: Path, data) -> None:
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def _r(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


class Job:
    def __init__(self, job_id: str, root: Path = JOBS):
        self.id = job_id
        self.dir = root / job_id
        self.dir.mkdir(parents=True, exist_ok=True)

    @classmethod
    def create(cls, dxf_path: str, source: str, target: str, name: str = "", root: Path = JOBS) -> "Job":
        job = cls(time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:6], root)
        shutil.copy(dxf_path, job.dir / "input.dxf")
        job.meta = {"id": job.id, "name": name or Path(dxf_path).name, "source": source, "target": target,
                    "status": "created", "created_at": time.strftime("%Y-%m-%dT%H:%M:%S"), "stages": {}}
        job.save_meta()
        return job

    @property
    def meta(self) -> dict:
        return _r(self.dir / "job.json")

    @meta.setter
    def meta(self, v: dict) -> None:
        self._meta = v

    def save_meta(self) -> None:
        _w(self.dir / "job.json", self._meta)

    def _stage_done(self, name: str, **info) -> None:
        m = self.meta
        m["stages"][name] = {"done_at": time.strftime("%Y-%m-%dT%H:%M:%S"), **info}
        m["status"] = name
        self._meta = m
        self.save_meta()

    # ── stages ──
    def inventory(self) -> dict:
        doc, audit_errors = inv.load(str(self.dir / "input.dxf"))
        items = inv.inventory(doc)
        summ = inv.summary(items)
        walls = inv.walls(doc)
        _w(self.dir / "inventory.json", {"summary": summ, "audit_errors": audit_errors, "version": doc.dxfversion,
                                          "items": [it.to_dict() for it in items], "walls": walls})
        self._stage_done("inventory", **summ)
        return summ

    def prepare(self) -> dict:
        data = _r(self.dir / "inventory.json")
        items = [inv.TextItem(**d) for d in data["items"]]
        source = self.meta["source"]
        langs = {source} if source != "auto" else {"ru", "ja"} if self.meta["target"] == "en" else {"ru", "en"}
        segments, handle_map, skipped = prep.prepare(items, langs, data.get("walls", {}))
        _w(self.dir / "segments.json", {"segments": [s.to_dict() for s in segments], "handle_map": handle_map, "skipped": skipped})
        info = {"segments": len(segments), "entities": len(handle_map), "skipped": len(skipped),
                "paragraphs": sum(1 for s in segments if s.lines > 1)}
        self._stage_done("prepare", **info)
        return info

    def translate(self, mode: str = "claude", model: str | None = None) -> dict:
        data = _r(self.dir / "segments.json")
        segments = [prep.Segment(**s) for s in data["segments"]]
        meta = self.meta
        source = meta["source"] if meta["source"] != "auto" else (segments[0].lang if segments else "ru")
        translator = tr.get_translator(mode, model)
        memory = Memory(self.dir.parent, source, meta["target"])
        remembered = [tr.Translation(s.id, memory.get(s.source), note="; ".join(n for n in ("from memory", tr._name_note(source, s.source)) if n))
                      for s in segments if memory.get(s.source)]
        seen = {t.id for t in remembered}
        fresh = translator.translate([s for s in segments if s.id not in seen], source, meta["target"]) if len(seen) < len(segments) else []
        by_id = {t.id: t for t in remembered + fresh}
        results = [by_id[s.id] for s in segments if s.id in by_id]
        _w(self.dir / "translations.json", {"mode": mode, "model": getattr(translator, "model", mode), "usage": translator.usage,
                                            "from_memory": len(remembered), "translations": [asdict(t) for t in results]})
        fits = fitmod.assess(segments, results, meta["target"])
        _w(self.dir / "fit.json", [asdict(f) for f in fits])
        info = {"translated": sum(1 for t in results if t.ok), "from_memory": len(remembered), "needs_attention": sum(1 for t in results if not t.ok),
                "flagged": {k: sum(1 for f in fits if f.flag == k) for k in ("long", "tight", "overflow")}, "usage": translator.usage}
        self._stage_done("translate", **info)
        return info

    def review_table(self) -> list[dict]:
        """What the reviewer sees: one row per unique segment."""
        segs = _r(self.dir / "segments.json")["segments"]
        trans = {t["id"]: t for t in _r(self.dir / "translations.json")["translations"]}
        fits = {f["id"]: f for f in _r(self.dir / "fit.json")}
        review = _r(self.dir / "review.json") if (self.dir / "review.json").exists() else {}
        rows = []
        for s in segs:
            t = trans.get(s["id"], {})
            f = fits.get(s["id"], {})
            r = review.get(s["id"], {})
            rows.append({
                "id": s["id"], "source": s["plain"], "source_marked": s["source"], "lang": s["lang"],
                "target": r.get("text", t.get("target", "")), "model_target": t.get("target", ""),
                "ok": t.get("ok", False), "note": t.get("note", ""), "count": len(s["handles"]), "kinds": sorted(set(s["kinds"])),
                "context": s["context"], "vertical": s["vertical"], "lines": s.get("lines", 1), "cap_em": f.get("cap_em", 0),
                "fit": f.get("flag", ""), "ratio": f.get("ratio", 1.0), "width_factor": r.get("width_factor", f.get("suggested_width_factor", 1.0)),
                "width_override": "width_factor" in r,
                "approved": r.get("approved", False), "edited": "text" in r,
            })
        return rows

    def set_review(self, seg_id: str, text: str | None = None, approved: bool | None = None, width_factor: float | None = None,
                   revert: bool = False) -> None:
        p = self.dir / "review.json"
        review = _r(p) if p.exists() else {}
        entry = review.get(seg_id, {})
        if revert:
            entry.pop("text", None)
        if text is not None:
            entry["text"] = text
        if approved is not None:
            entry["approved"] = approved
        if width_factor is not None:
            entry["width_factor"] = width_factor
        review[seg_id] = entry
        _w(p, review)

    def approve_all_ok(self) -> int:
        """Approve every segment the model translated cleanly (a reviewer can still edit later).
        Width factors are computed at patch time unless a reviewer sets one."""
        n = 0
        for row in self.review_table():
            if row["ok"] and not row["approved"]:
                self.set_review(row["id"], approved=True)
                n += 1
        return n

    def remember(self) -> int:
        """Store this job's approved translations in the memory for the language
        pair. Call it after review, so only checked translations are reused."""
        m = self.meta
        if m["source"] == "auto" or _r(self.dir / "translations.json").get("mode") == "mock":
            return 0
        rows = self.review_table()
        return Memory(self.dir.parent, m["source"], m["target"]).learn(
            {r["source_marked"]: r["target"] for r in rows if r["approved"] and r["target"].strip()})

    def patch(self, only_approved: bool = True, learn: bool = False) -> dict:
        inv_data = _r(self.dir / "inventory.json")
        items = [inv.TextItem(**d) for d in inv_data["items"]]
        segments = [prep.Segment(**s) for s in _r(self.dir / "segments.json")["segments"]]
        rows = self.review_table()
        approved = {r["id"]: r["target"] for r in rows if (r["approved"] or not only_approved) and r["target"].strip()}
        if learn:
            self.remember()
        wfs = {r["id"]: float(r["width_factor"]) for r in rows if r["id"] in approved and r["width_override"]}
        doc, _ = inv.load(str(self.dir / "input.dxf"))
        res = pt.apply(doc, items, segments, approved, self.meta["target"], wfs)
        out = self.dir / "output.dxf"
        pt.save(doc, str(out))
        ver = pt.verify(str(self.dir / "input.dxf"), str(out))
        report = self._report(res, ver, rows)
        (self.dir / "report.md").write_text(report, encoding="utf-8")
        info = {"patched": res.patched, "skipped": len(res.skipped), "narrowed": res.width_factors, "overflow": len(res.overflow),
                "style_changes": res.style_changes, "verified": ver.ok, "problems": ver.problems}
        self._stage_done("patch", **info)
        return info

    def _report(self, res: pt.PatchResult, ver: pt.Verification, rows: list[dict]) -> str:
        m = self.meta
        t = _r(self.dir / "translations.json")
        lines = [
            f"# Translation report: {m['name']}",
            "",
            f"Source {m['source']} to target {m['target']}. Model {t.get('model')}.",
            "",
            "## Result",
            f"- Unique strings: {len(rows)}",
            f"- Approved and written: {sum(1 for r in rows if r['approved'])}",
            f"- Entities patched: {res.patched}",
            f"- Left untranslated (not approved or needs a human): {sum(1 for r in rows if not r['approved'])}",
            f"- Entities narrowed to fit: {res.width_factors}",
            f"- Still overflowing (shorten these): {len(res.overflow)}",
            *[f"  - {i}: {next((r['target'][:70] for r in rows if r['id'] == i), '')!r}" for i in res.overflow],
            f"- Text styles changed for the target font: {len(res.style_changes)}",
            *[f"  - {s}" for s in res.style_changes],
            "",
            "## Verification",
            f"- Geometry unchanged: {'yes' if ver.ok else 'NO'}",
            f"- Non-text entities: {ver.entities_before} before, {ver.entities_after} after",
            f"- Text entities in model space: {ver.text_before} before, {ver.text_after} after",
            *[f"- Problem: {p}" for p in ver.problems],
            "",
            "## Needs a human",
            *[f"- {r['id']}: {r['source'][:60]!r} ({r['note'] or 'not approved'})" for r in rows if not r['approved']][:50],
            "",
            f"## Usage\n- Input tokens {t.get('usage', {}).get('input', 0)}, cache reads {t.get('usage', {}).get('cache_read', 0)}, output tokens {t.get('usage', {}).get('output', 0)}",
        ]
        return "\n".join(lines) + "\n"

    def run_all(self, mode: str = "claude", model: str | None = None, auto_approve: bool = True) -> dict:
        self.inventory(); self.prepare(); info = self.translate(mode, model)
        if auto_approve:
            self.approve_all_ok()
        return {"translate": info, "patch": self.patch()}
