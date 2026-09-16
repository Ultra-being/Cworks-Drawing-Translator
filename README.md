# Cworks Drawing Translator (dxft)

Translates the text layer of AutoCAD DXF drawings between Russian, Japanese and English without touching geometry. Built for construction documents. A qualified CAD operator reviews every translation before release.

Human at the start. AI in the middle. Human at the end.

## How it works

Seven stages, one JSON file each, in `jobs/<id>/`:

| Stage | Does | Output |
|---|---|---|
| 1 Inventory | Finds every TEXT, MTEXT, block attribute, dimension override and leader; detects language; notes style, size, vertical text | `inventory.json` |
| 2 Prepare | Protects numbers, units and codes; replaces MTEXT formatting codes with `⟦n⟧` markers; de-duplicates identical strings | `segments.json` |
| 3 Translate | Claude, in batches of 60, with the rules and glossary from `workspaces/`; every marker is verified and failures are retried alone, then flagged | `translations.json` |
| 4 Fit | Estimates rendered width vs the original; flags strings that grew; suggests a width factor | `fit.json` |
| 5 Review | The operator's decisions: approve, edit, width factor. Edits win over the model | `review.json` |
| 6 Patch | Writes approved text back into the same entities by handle; swaps text styles to a Japanese-capable font when the target is Japanese | `output.dxf` |
| 7 Verify | Re-opens the output and proves geometry and entity counts are unchanged | `report.md` |

Rules and glossaries are markdown in `workspaces/`. Edit them to change behaviour.

## Use

```
pip install -e .
dxft inventory drawing.dxf
dxft run drawing.dxf --source ja --target en            # full run, auto-approves clean translations
dxft run drawing.dxf --source ru --target en --no-approve   # stop before patching
dxft review <job-id>                                     # the table
dxft approve <job-id> s00012 --text "Site plan"          # edit one
dxft patch <job-id>                                      # write output.dxf
dxft run drawing.dxf --mock                               # no API, proves the round trip
```

Needs `ANTHROPIC_API_KEY` in the environment or in `~/.config/dxft/env`. Default model `claude-opus-5` (`DXFT_MODEL` to change).

## Input

AutoCAD 2018 DXF (`AC1032`, UTF-8) is the tested format. Export from DWG with `SAVEAS` → DXF 2018. Older DXF versions with code pages are opened tolerantly but untested.

## Verified on

- Japanese electrical set (6 sheets, 100–300 strings each, SHX + extfont2 bigfont, vertical style present)
- Russian architectural set (3 files, ~2,200 strings, MTEXT with inline fonts/heights/colours, title-block attributes, 1,100+ dimensions)

Mock round trip on both: geometry fingerprint identical, every MTEXT formatting skeleton identical.
