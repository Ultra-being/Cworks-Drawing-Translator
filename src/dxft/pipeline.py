"""The job runner. One folder per drawing, one JSON file per stage, so every
step is inspectable and any step can be re-run or hand-edited.

jobs/<id>/
  input.dxf|pdf      the file as uploaded
  job.json           settings + status
  inventory.json     stage 1
  segments.json      stage 2 (unique strings with markers)
  translations.json  stage 3 (model output, marker-checked)
  fit.json           stage 4
  review.json        stage 5: what the human approved (id -> text); edits win
  output.dxf|pdf     stage 6
  report.md          stage 7
"""
from __future__ import annotations

import json
import os
import shutil
import threading
import re
import time
import uuid
from dataclasses import asdict
from pathlib import Path

from . import inventory as inv
from . import prepare as prep
from . import translate as tr
from . import fit as fitmod
from . import patch as pt
from . import pdfdoc

JOBS = Path("jobs")


def pricing() -> dict:
    """USD per million tokens per model + JPY rate, from workspaces/pricing.json."""
    import os
    root = Path(os.environ.get("DXFT_WORKSPACES", Path(__file__).resolve().parents[2] / "workspaces"))
    p = root / "pricing.json"
    try:
        return _r(p)
    except Exception:
        return {"jpy_per_usd": 150, "usd_per_million": {"default": {"input": 5, "output": 25, "cache_read": 0.5, "cache_write": 6.25}}}


def cost_usd(entry: dict, prices: dict) -> float:
    table = prices.get("usd_per_million", {})
    rate = table.get(entry.get("model"), table.get("default", {}))
    return sum(float(entry.get(k, 0) or 0) / 1e6 * float(rate.get(k, 0)) for k in ("input", "output", "cache_read", "cache_write"))


class Memory:
    """Exact-match translation memory per language pair: every approved
    translation is remembered, and the next sheet of the same set reuses it
    without asking the model. Title blocks, legends and repeated labels come
    out identical on every sheet, and cost nothing."""

    def __init__(self, root: Path, source: str, target: str):
        self.path = root / "_memory" / f"{source}-{target}.json"
        # seed shipped with the code (workspaces/memory), then what this server learned on top
        import os
        seed = Path(os.environ.get("DXFT_WORKSPACES", Path(__file__).resolve().parents[2] / "workspaces")) / "memory" / f"{source}-{target}.json"
        self.data: dict[str, str] = {}
        if seed.exists():
            try:
                self.data.update(_r(seed))
            except Exception:
                pass
        if self.path.exists():
            self.data.update(_r(self.path))

    def get(self, source_text: str) -> str | None:
        return self.data.get(source_text)

    def learn(self, pairs: dict[str, str]) -> int:
        n = 0
        for k, v in pairs.items():
            if v.strip() and self.data.get(k) != v:
                self.data[k] = v
                n += 1
        if not n:
            return 0
        # The memory is shared, and two people can be storing at once. Writing
        # back what was read a moment ago would drop whatever the other one
        # saved in between, without a word. Read it again here, under the lock,
        # and add to that.
        with _MEMORY_LOCK:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            latest: dict[str, str] = {}
            if self.path.exists():
                try:
                    latest.update(_r(self.path))
                except Exception:
                    pass
            latest.update({k: v for k, v in pairs.items() if v.strip()})
            _w(self.path, latest)
            self.data.update(latest)
        return n


_MEMORY_LOCK = threading.Lock()


def _w(path: Path, data) -> None:
    """Write whole or not at all: a half-written file is worse than an old one,
    and these are read by the next stage and by the other person's job."""
    tmp = path.with_name(path.name + f".{os.getpid()}.part")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, path)


def _r(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def _to_check(rows: list[dict], overflow: list[str], flags: dict | None = None) -> dict[str, dict[str, list[str]]]:
    """place -> what is worth a look there -> the strings themselves.

    A count tells someone there is a problem; the string tells them what to
    look for. Both, per page, so the list can be read straight off the paper
    without opening the job.
    """
    over = set(overflow)
    todo: dict[str, dict[str, list[str]]] = {}
    # A reviewer who has looked at the sheet knows things no measurement does.
    # Their flag sits beside the measured ones and reads as what it is.
    for place, note in (flags or {}).items():
        todo.setdefault(place, {}).setdefault("flagged by the reviewer", []).append(str(note).strip() or "no note given")
    for r in rows:
        kinds = []
        if r["id"] in over:
            kinds.append("wider than the space")
        if not r["approved"]:
            kinds.append("not approved, so left in the original language")
        elif not r["ok"]:
            kinds.append("the model was unsure")
        if not kinds:
            continue
        shown = (r["display"] or r["source"]).strip().replace("\n", " ")[:40]
        for place in (r["places"] or ["somewhere not recorded"]):
            for k in kinds:
                todo.setdefault(place, {}).setdefault(k, []).append(shown)
    return todo


def _place_order(p: str):
    bits = p.split()
    return (0, int(bits[1])) if p.startswith("page ") and len(bits) > 1 and bits[1].isdigit() else (1, 0)


PAGE_HANDLE = re.compile(r"^p(\d+):")


def _places(seg: dict) -> list[str]:
    """Where this segment's instances sit, nearest-first by page number.

    Jobs prepared before this was recorded have no places on them. A PDF
    handle carries its page ("p19:34"), so those are read back from the
    handles rather than making anyone translate the file again; a DXF job
    older than this shows nothing, and a re-read fills it in.
    """
    got = [p for p in (seg.get("places") or []) if p]
    if not got:
        got = [f"page {m.group(1)}" for h in seg.get("handles", [])
               for m in (PAGE_HANDLE.match(h),) if m]
    uniq = sorted(set(got), key=lambda t: (int(t.split()[1]) if t.startswith("page ") and t.split()[1].isdigit() else 1 << 30, t))
    return uniq


class Job:
    def __init__(self, job_id: str, root: Path = JOBS):
        self.id = job_id
        self.dir = root / job_id
        self.dir.mkdir(parents=True, exist_ok=True)

    @classmethod
    def create(cls, dxf_path: str, source: str, target: str, name: str = "", root: Path = JOBS,
               client: str = "", project: str = "") -> "Job":
        job = cls(time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:6], root)
        fmt = "pdf" if (name or dxf_path).lower().endswith(".pdf") else "dxf"
        shutil.copy(dxf_path, job.dir / f"input.{fmt}")
        job.meta = {"id": job.id, "name": name or Path(dxf_path).name, "source": source, "target": target, "fmt": fmt,
                    "client": client.strip() or "Unfiled", "project": project.strip() or "General",
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

    @property
    def fmt(self) -> str:
        return self._meta.get("fmt", "dxf") if hasattr(self, "_meta") else self.meta.get("fmt", "dxf")

    @property
    def input_path(self) -> Path:
        return self.dir / f"input.{self.fmt}"

    @property
    def output_path(self) -> Path:
        return self.dir / f"output.{self.fmt}"

    def _stage_done(self, name: str, **info) -> None:
        m = self.meta
        m["stages"][name] = {"done_at": time.strftime("%Y-%m-%dT%H:%M:%S"), **info}
        m["status"] = name
        self._meta = m
        self.save_meta()

    # ── stages ──
    def inventory(self) -> dict:
        if self.fmt == "pdf":
            doc = pdfdoc.open_pdf(str(self.input_path))
            items, walls, geo = pdfdoc.inventory(doc)
            summ = inv.summary(items)
            summ["pages"] = len(doc)
            _w(self.dir / "inventory.json", {"summary": summ, "audit_errors": 0, "version": "pdf",
                                              "items": [it.to_dict() for it in items], "walls": walls, "pdf_geo": geo})
            self._stage_done("inventory", **summ)
            return summ
        doc, audit_errors = inv.load(str(self.input_path))
        items = inv.inventory(doc)
        summ = inv.summary(items)
        walls = inv.walls(doc)
        floors = inv.floors(doc)
        frames = inv.sheet_frames(doc)
        links = inv.linked_files(doc)
        layouts = inv.paper_layouts(doc)
        summ["links"] = links
        summ["layouts"] = len(layouts)
        _w(self.dir / "inventory.json", {"summary": summ, "audit_errors": audit_errors, "version": doc.dxfversion,
                                          "items": [it.to_dict() for it in items], "walls": walls,
                                          "floors": floors, "frames": frames, "links": links,
                                          "layouts": layouts})
        self._stage_done("inventory", **summ)
        return summ

    def _measure_font(self) -> None:
        """Widths are measured with the font the output is written in."""
        from . import layout
        if self.fmt == "pdf":
            try:
                import pymupdf_fonts
                layout.set_measure_font(pymupdf_fonts.fontbuffers["notos"], "NotoSans")
                return
            except Exception:
                pass
        layout.set_measure_font()

    def prepare(self) -> dict:
        self._measure_font()
        data = _r(self.dir / "inventory.json")
        items = [inv.TextItem(**d) for d in data["items"]]
        source = self.meta["source"]
        langs = {source} if source != "auto" else {"ru", "ja"} if self.meta["target"] == "en" else {"ru", "en"}
        segments, handle_map, skipped = prep.prepare(items, langs, data.get("walls", {}), data.get("floors", {}))
        _w(self.dir / "segments.json", {"segments": [s.to_dict() for s in segments], "handle_map": handle_map, "skipped": skipped})
        info = {"segments": len(segments), "entities": len(handle_map), "skipped": len(skipped),
                "paragraphs": sum(1 for s in segments if s.lines > 1)}
        self._stage_done("prepare", **info)
        return info

    def translate(self, mode: str = "claude", model: str | None = None, on_progress=None) -> dict:
        self._measure_font()
        data = _r(self.dir / "segments.json")
        segments = [prep.Segment(**s) for s in data["segments"]]
        meta = self.meta
        source = meta["source"] if meta["source"] != "auto" else (segments[0].lang if segments else "ru")
        translator = tr.get_translator(mode, model)
        memory = Memory(self.dir.parent, source, meta["target"])
        remembered = [tr.Translation(s.id, memory.get(s.source), note="; ".join(n for n in ("from memory", tr._name_note(source, s.source)) if n))
                      for s in segments if memory.get(s.source)]
        seen = {t.id for t in remembered}
        # Strings found in the memory are done before the first call is made,
        # so they count towards the total from the start rather than making
        # the first batch look like a huge leap.
        total = len(segments)
        if on_progress:
            on_progress(len(remembered), total, "translate")
        todo = [s for s in segments if s.id not in seen]
        relay = (lambda done, _n: on_progress(len(remembered) + done, total, "translate")) if on_progress else None
        fresh = translator.translate(todo, source, meta["target"], on_progress=relay) if todo else []
        by_id = {t.id: t for t in remembered + fresh}
        results = [by_id[s.id] for s in segments if s.id in by_id]
        _w(self.dir / "translations.json", {"mode": mode, "model": getattr(translator, "model", mode), "usage": translator.usage,
                                            "from_memory": len(remembered), "translations": [asdict(t) for t in results]})
        if mode != "mock":
            m = self.meta
            m.setdefault("usage_log", []).append({"at": time.strftime("%Y-%m-%dT%H:%M:%S"), "model": getattr(translator, "model", mode),
                                                  "segments": len(segments) - len(remembered), **translator.usage})
            self._meta = m
            self.save_meta()
        fits = fitmod.assess(segments, results, meta["target"])
        # Strings that only fit by being squeezed -- overflowing the space, or
        # condensed well below normal letter widths -- get a second attempt:
        # ask for tighter wording within the exact budget, then measure again.
        # Shorter English reads better on a drawing than narrow English.
        over = {f.id for f in fits if f.flag in ("overflow", "tight")}
        shortened = 0
        if over and mode != "mock":
            seg_by_id = {s.id: s for s in segments}
            budgets = {}
            for f in fits:
                if f.id in over:
                    s = seg_by_id[f.id]
                    room = min(c for c in s.caps if c > 0) * s.lines if any(c > 0 for c in s.caps) else 0
                    budgets[f.id] = max(4, int(room / 0.6 * 0.95)) if room else 0
            budgets = {k: v for k, v in budgets.items() if v}
            # The bar reached the end of the strings a moment ago, but the work
            # has not: what did not fit goes back for tighter wording, and that
            # is another call or two. Saying so beats sitting at 100%.
            if on_progress and budgets:
                on_progress(len(budgets), len(budgets), "shortening")
            by_id = {t.id: t for t in results}
            new_text = tr.shorten(translator, [seg_by_id[i] for i in budgets], {i: by_id[i].target for i in budgets}, budgets, source, meta["target"])
            for sid, text in new_text.items():
                by_id[sid].target = text
                by_id[sid].note = (by_id[sid].note + "; " if by_id[sid].note else "") + "shortened to fit"
                shortened += 1
            if shortened:
                _w(self.dir / "translations.json", {"mode": mode, "model": getattr(translator, "model", mode), "usage": translator.usage,
                                                    "from_memory": len(remembered), "translations": [asdict(t) for t in results]})
                fits = fitmod.assess(segments, results, meta["target"])
        _w(self.dir / "fit.json", [asdict(f) for f in fits])
        info = {"translated": sum(1 for t in results if t.ok), "from_memory": len(remembered), "shortened_to_fit": shortened,
                "needs_attention": sum(1 for t in results if not t.ok),
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
            where = _places(s)
            t = trans.get(s["id"], {})
            f = fits.get(s["id"], {})
            r = review.get(s["id"], {})
            target = r.get("text", t.get("target", ""))
            rows.append({
                "id": s["id"], "source": s["plain"], "source_marked": s["source"], "lang": s["lang"],
                "target": target, "display": prep.MARK_RE.sub("", target), "has_codes": bool(s.get("codes")),
                "model_target": t.get("target", ""),
                "ok": t.get("ok", False), "note": t.get("note", ""), "count": len(s["handles"]), "kinds": sorted(set(s["kinds"])),
                "context": s["context"], "vertical": s["vertical"], "lines": s.get("lines", 1), "cap_em": f.get("cap_em", 0),
                "fit": f.get("flag", ""), "ratio": f.get("ratio", 1.0), "width_factor": r.get("width_factor", f.get("suggested_width_factor", 1.0)),
                "width_override": "width_factor" in r,
                "approved": r.get("approved", False), "edited": "text" in r,
                "places": where, "place": ", ".join(where[:3]) + ("…" if len(where) > 3 else ""),
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
        n = Memory(self.dir.parent, m["source"], m["target"]).learn(
            {r["source_marked"]: r["target"] for r in rows if r["approved"] and r["target"].strip()})
        # Noted on the job, so deleting it can say whether the work would
        # really be lost or is already safe in the memory.
        m["remembered_at"] = time.strftime("%Y-%m-%dT%H:%M:%S")
        self._meta = m
        self.save_meta()
        return n

    def patch(self, only_approved: bool = True, learn: bool = False) -> dict:
        self._measure_font()
        inv_data = _r(self.dir / "inventory.json")
        items = [inv.TextItem(**d) for d in inv_data["items"]]
        segments = [prep.Segment(**s) for s in _r(self.dir / "segments.json")["segments"]]
        rows = self.review_table()
        approved = {r["id"]: r["target"] for r in rows if (r["approved"] or not only_approved) and r["target"].strip()}
        if learn:
            self.remember()
        wfs = {r["id"]: float(r["width_factor"]) for r in rows if r["id"] in approved and r["width_override"]}
        if self.fmt == "pdf":
            doc = pdfdoc.open_pdf(str(self.input_path))
            n_before, h_before = pdfdoc.fingerprint(doc)
            res = pdfdoc.apply(doc, inv_data.get("pdf_geo", {}), segments, approved, self.meta["target"], wfs)
            out = self.output_path
            doc.save(str(out), garbage=3, deflate=True)
            doc2 = pdfdoc.open_pdf(str(out))
            n_after, h_after = pdfdoc.fingerprint(doc2)
            problems = []
            if n_before != n_after:
                problems.append(f"line-art count changed: {n_before} -> {n_after}")
            elif h_before != h_after:
                problems.append("line-art fingerprint changed")
            ver = pt.Verification(ok=not problems, entities_before=n_before, entities_after=n_after, geometry_before=h_before[:12],
                                  geometry_after=h_after[:12], text_before=len(items), text_after=len(items), problems=problems)
        else:
            doc, _ = inv.load(str(self.input_path))
            res = pt.apply(doc, items, segments, approved, self.meta["target"], wfs)
            out = self.output_path
            pt.save(doc, str(out))
            ver = pt.verify(str(self.input_path), str(out), added_text=res.added_lines)
        report = self._report(res, ver, rows)
        (self.dir / "report.md").write_text(report, encoding="utf-8")
        info = {"patched": res.patched, "skipped": len(res.skipped), "narrowed": res.width_factors, "overflow": len(res.overflow),
                "added_lines": res.added_lines, "ascii_forms": res.widened_forms,
                "boxes_pulled_in": res.boxed,
                "style_changes": res.style_changes, "verified": ver.ok, "problems": ver.problems}
        self._stage_done("patch", **info)
        return info

    def _report(self, res: pt.PatchResult, ver: pt.Verification, rows: list[dict]) -> str:
        """The report someone reads before sending the drawing on.

        It used to open with a column of counters -- entities patched, ASCII
        forms, line-work fingerprints -- which are my numbers, not theirs, and
        buried the one question they have under them. It now answers that
        question first, says which pages to look at and what to look for, and
        keeps the engineering at the bottom where it is still there when a
        fault needs chasing.
        """
        m = self.meta
        t = _r(self.dir / "translations.json")
        sheet = "page" if self.fmt == "pdf" else "sheet"
        pages = (m.get("stages", {}).get("inventory", {}) or {}).get("pages")
        todo = _to_check(rows, res.overflow, m.get("flags") or {})
        unapproved = [r for r in rows if not r["approved"]]
        links = (m.get("stages", {}).get("inventory", {}) or {}).get("links") or []

        if not ver.ok:
            verdict = ["**Do not send this on yet.** The check that the drawing itself was not altered",
                       "did not pass, which should never happen. Send this report to Allan.",
                       *[f"- {p}" for p in ver.problems]]
        elif not todo:
            verdict = [f"**Ready to send.** Every string was translated and written in, and the drawing",
                       "itself is untouched -- only the text differs from the original."]
        else:
            n = len(todo)
            verdict = [f"**Ready to send, with {n} {sheet}{'' if n == 1 else 's'} worth a glance first.**",
                       "",
                       "Nothing is missing: all the text is in the drawing. What is listed below either",
                       f"runs wider than the space it was given, or nobody approved it. Whoever takes this",
                       "on can fix any of it in DWG in a few seconds, once they know where to look."]

        lines = [
            f"# {m['name']}",
            "",
            f"{m['source']} to {m['target']}"
            + (f" · {pages} pages" if pages else "")
            + f" · {time.strftime('%d %B %Y')}",
            "",
            *verdict,
            "",
        ]

        if todo:
            lines += [f"## {sheet.capitalize()}s to look at", ""]
            for place in sorted(todo, key=lambda q: (_place_order(q), q)):
                for kind, strings in sorted(todo[place].items()):
                    if kind == "flagged by the reviewer":
                        lines.append(f"- **{place}** — flagged by the reviewer: {'; '.join(strings)}")
                        continue
                    shown = ", ".join(f'"{x}"' for x in strings[:4])
                    more = f" and {len(strings) - 4} more" if len(strings) > 4 else ""
                    lines.append(f"- **{place}** — {len(strings)} {kind}: {shown}{more}")
            lines.append("")

        if links:
            lines += ["## Files this drawing points at but does not contain", "",
                      "A picture or another drawing was placed into this one by reference. It is not",
                      "inside the file, so it is blank here and its file name may be drawn across the",
                      "sheet instead. That name is a path, not a label, and is left untranslated.",
                      "Ask the sender for these:", "",
                      *[f"- `{f}`" for f in links], ""]

        lines += [
            "## What was done", "",
            f"- {len(rows)} different strings translated, written into {res.patched} places in the file",
            f"- {sum(1 for r in rows if r['approved'])} approved"
            + (f", {len(unapproved)} left in the original language" if unapproved else ""),
            f"- {res.width_factors} made narrower so they would fit their space",
            *([f"- {res.added_lines} given an extra line below, where the cell was too narrow"] if res.added_lines else []),
            *([f"- {res.boxed} text boxes pulled in to the cell they sit in"] if res.boxed else []),
            *([f"- {res.widened_forms} full-width characters changed to ASCII so the Latin font could draw them"]
              if res.widened_forms else []),
            f"- Geometry {'unchanged' if ver.ok else 'CHANGED -- see above'}: nothing was moved, resized or deleted",
            "",
            "## If something looks wrong", "",
            "Open the **Before** view at the same place and compare. Drawings often arrive with",
            "text already overrunning its own cells, and where the original did it the translation",
            "will too. If the original was clean and this is not, use **Report a problem**.",
            "",
            "## Technical detail", "",
            f"- Model {t.get('model')}, mode {t.get('mode')}",
            f"- Entities patched {res.patched}, narrowed {res.width_factors}, lines added {res.added_lines},"
            f" boxes pulled in {res.boxed}, ASCII forms {res.widened_forms}",
            f"- Still overflowing after narrowing: {len(res.overflow)}",
            *[f"  - {next((r['place'] for r in rows if r['id'] == i), '') or i}: "
              f"{next((r['display'][:70] for r in rows if r['id'] == i), '')!r}" for i in res.overflow],
            f"- Text styles changed for the target font: {len(res.style_changes)}",
            *[f"  - {x}" for x in res.style_changes],
            f"- Verification: geometry unchanged {'yes' if ver.ok else 'NO'};"
            f" line-work {ver.entities_before} before, {ver.entities_after} after;"
            f" text {ver.text_before} before, {ver.text_after} after",
            *[f"  - Problem: {x}" for x in ver.problems],
            f"- Tokens: input {t.get('usage', {}).get('input', 0)},"
            f" cache reads {t.get('usage', {}).get('cache_read', 0)},"
            f" output {t.get('usage', {}).get('output', 0)}",
            "",
        ]
        return "\n".join(lines) + "\n"

    def run_all(self, mode: str = "claude", model: str | None = None, auto_approve: bool = True) -> dict:
        self.inventory(); self.prepare(); info = self.translate(mode, model)
        if auto_approve:
            self.approve_all_ok()
        return {"translate": info, "patch": self.patch()}
