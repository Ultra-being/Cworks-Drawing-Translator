"""dxft — command line.

  dxft inventory <file.dxf>                      what is in the drawing
  dxft run <file.dxf> --source ja --target en    full pipeline into jobs/<id>/
  dxft run ... --mock                            no API: proves the round trip
  dxft review <job-id>                           print the review table
  dxft approve <job-id> <seg-id> [--text "..."]  approve / edit one segment
  dxft patch <job-id>                            write output.dxf from approved rows
  dxft verify <job-id>                           re-check output against input
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
        print("approved: ", job.approve_all_ok(apply_width_factors=a.fit))
        print("patch:    ", json.dumps(job.patch(), ensure_ascii=False))
        print(f"output:   {job.dir / 'output.dxf'}\nreport:   {job.dir / 'report.md'}")
    else:
        print(f"review with: dxft review {job.id}")


def cmd_review(a):
    job = Job(a.job, Path(a.jobs))
    rows = job.review_table()
    for r in rows:
        mark = "✓" if r["approved"] else ("!" if not r["ok"] else " ")
        fit = f" [{r['fit']} x{r['ratio']}]" if r["fit"] else ""
        print(f"{mark} {r['id']} ×{r['count']:<3} {r['source'][:40]!r:44} → {r['target'][:50]!r}{fit}")
    print(f"\n{len(rows)} segments, {sum(1 for r in rows if r['approved'])} approved, {sum(1 for r in rows if not r['ok'])} need a human")


def cmd_approve(a):
    job = Job(a.job, Path(a.jobs))
    job.set_review(a.segment, text=a.text, approved=not a.reject, width_factor=a.width)
    print("ok")


def cmd_patch(a):
    job = Job(a.job, Path(a.jobs))
    print(json.dumps(job.patch(only_approved=not a.all), ensure_ascii=False, indent=2))


def cmd_verify(a):
    from .patch import verify
    job = Job(a.job, Path(a.jobs))
    v = verify(str(job.dir / "input.dxf"), str(job.dir / "output.dxf"))
    print(json.dumps(v.__dict__, indent=2))


def main(argv=None):
    p = argparse.ArgumentParser(prog="dxft", description="Cworks Drawing Translator")
    p.add_argument("--jobs", default=str(JOBS))
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("inventory"); s.add_argument("file"); s.add_argument("--limit", type=int, default=25); s.set_defaults(fn=cmd_inventory)
    s = sub.add_parser("run"); s.add_argument("file"); s.add_argument("--source", default="auto"); s.add_argument("--target", default="en")
    s.add_argument("--mock", action="store_true"); s.add_argument("--model"); s.add_argument("--no-approve", action="store_true")
    s.add_argument("--fit", action="store_true", help="apply suggested width factors to overlong text"); s.set_defaults(fn=cmd_run)
    s = sub.add_parser("review"); s.add_argument("job"); s.set_defaults(fn=cmd_review)
    s = sub.add_parser("approve"); s.add_argument("job"); s.add_argument("segment"); s.add_argument("--text"); s.add_argument("--width", type=float); s.add_argument("--reject", action="store_true"); s.set_defaults(fn=cmd_approve)
    s = sub.add_parser("patch"); s.add_argument("job"); s.add_argument("--all", action="store_true", help="write every translation, approved or not"); s.set_defaults(fn=cmd_patch)
    s = sub.add_parser("verify"); s.add_argument("job"); s.set_defaults(fn=cmd_verify)

    a = p.parse_args(argv)
    a.fn(a)


if __name__ == "__main__":
    sys.exit(main())
