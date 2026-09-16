"""dxft — command line.

  dxft inventory <file.dxf>                      what is in the drawing
  dxft run <file.dxf> --source ja --target en    full pipeline into jobs/<id>/
  dxft run ... --mock                            no API: proves the round trip
  dxft review <job-id>                           print the review table
  dxft approve <job-id> <seg-id> [--text "..."]  approve / edit one segment
  dxft patch <job-id>                            write output.dxf from approved rows
  dxft verify <job-id>                           re-check output against input
  dxft remember <job-id>                         store reviewed translations in the memory (reused on later sheets)
  dxft serve [--port 8765]                       the web app
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from . import inventory as inv
from .pipeline import Job, JOBS


def cmd_inventory(a):
    doc, errors = inv.load(a.file)
    items = inv.inventory(doc)
    s = inv.summary(items)
    print(f"{Path(a.file).name}: {doc.acad_release} ({doc.dxfversion}), audit errors {errors}")
    print(json.dumps(s, ensure_ascii=False))
    seen = set()
    for it in items:
        if it.lang in ("ru", "ja") and it.plain not in seen:
            seen.add(it.plain)
            print(f"  {it.kind:9} {it.where[:16]:16} {it.layer[:14]:14} {it.plain[:60]!r}")
            if len(seen) >= a.limit:
                break


def cmd_run(a):
    job = Job.create(a.file, a.source, a.target, root=Path(a.jobs))
    print(f"job {job.id}")
    print("inventory:", json.dumps(job.inventory(), ensure_ascii=False))
    print("prepare:  ", json.dumps(job.prepare(), ensure_ascii=False))
    print("translate:", json.dumps(job.translate("mock" if a.mock else "claude", a.model), ensure_ascii=False))
    if not a.no_approve:
        print("approved: ", job.approve_all_ok())
        print("patch:    ", json.dumps(job.patch(learn=a.learn), ensure_ascii=False))
        print(f"output:   {job.dir / 'output.dxf'}\nreport:   {job.dir / 'report.md'}")
    else:
        print(f"review with: dxft review {job.id}")


def cmd_review(a):
    job = Job(a.job, Path(a.jobs))
    rows = job.review_table()
    for r in rows:
        mark = "!" if not r["ok"] else "?" if r["note"] and r["note"] != "from memory" else "✓" if r["approved"] else " "
        fit = f" [{r['fit']} x{r['ratio']} wf{r['width_factor']}]" if r["fit"] else ""
        note = f"  ({r['note']})" if r["note"] else ""
        print(f"{mark} {r['id']} ×{r['count']:<3} {r['source'][:40]!r:44} → {r['target'][:50]!r}{fit}{note}")
    print(f"\n{len(rows)} segments, {sum(1 for r in rows if r['approved'])} approved, {sum(1 for r in rows if not r['ok'])} need a human, "
          f"{sum(1 for r in rows if r['note'] and r['note'] != 'from memory' and r['ok'])} to check, {sum(1 for r in rows if r['note'] == 'from memory')} from memory")


def cmd_approve(a):
    job = Job(a.job, Path(a.jobs))
    job.set_review(a.segment, text=a.text, approved=not a.reject, width_factor=a.width)
    print("ok")


def cmd_patch(a):
    job = Job(a.job, Path(a.jobs))
    print(json.dumps(job.patch(only_approved=not a.all, learn=a.learn), ensure_ascii=False, indent=2))


def cmd_remember(a):
    job = Job(a.job, Path(a.jobs))
    print(f"{job.remember()} translations stored")


def cmd_verify(a):
    from .patch import verify
    job = Job(a.job, Path(a.jobs))
    v = verify(str(job.dir / "input.dxf"), str(job.dir / "output.dxf"))
    print(json.dumps(v.__dict__, indent=2))


def cmd_serve(a):
    from .web import serve
    print(f"Cworks Drawing Translator: http://{a.host}:{a.port}")
    serve(a.host, a.port, Path(a.jobs))


def main(argv=None):
    p = argparse.ArgumentParser(prog="dxft", description="Cworks Drawing Translator")
    p.add_argument("--jobs", default=str(JOBS))
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("inventory"); s.add_argument("file"); s.add_argument("--limit", type=int, default=25); s.set_defaults(fn=cmd_inventory)
    s = sub.add_parser("run"); s.add_argument("file"); s.add_argument("--source", default="auto"); s.add_argument("--target", default="en")
    s.add_argument("--mock", action="store_true"); s.add_argument("--model"); s.add_argument("--no-approve", action="store_true")
    s.add_argument("--learn", action="store_true", help="store the approved translations in the memory for this language pair")
    s.set_defaults(fn=cmd_run)
    s = sub.add_parser("review"); s.add_argument("job"); s.set_defaults(fn=cmd_review)
    s = sub.add_parser("approve"); s.add_argument("job"); s.add_argument("segment"); s.add_argument("--text"); s.add_argument("--width", type=float); s.add_argument("--reject", action="store_true"); s.set_defaults(fn=cmd_approve)
    s = sub.add_parser("patch"); s.add_argument("job"); s.add_argument("--all", action="store_true", help="write every translation, approved or not")
    s.add_argument("--learn", action="store_true"); s.set_defaults(fn=cmd_patch)
    s = sub.add_parser("remember", help="store a reviewed job's translations in the memory"); s.add_argument("job"); s.set_defaults(fn=cmd_remember)
    s = sub.add_parser("verify"); s.add_argument("job"); s.set_defaults(fn=cmd_verify)
    s = sub.add_parser("serve"); s.add_argument("--host", default="127.0.0.1"); s.add_argument("--port", type=int, default=8765); s.set_defaults(fn=cmd_serve)

    a = p.parse_args(argv)
    a.fn(a)


if __name__ == "__main__":
    sys.exit(main())
