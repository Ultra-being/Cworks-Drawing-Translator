# Cworks Drawing Translator — how to use

Translates the text on CAD drawings (Russian or Japanese → English or Japanese) and gives you back the same drawing with the text replaced. Lines, dimensions, blocks and layout are never touched; the tool proves that on every job.

Open the app: **http://127.0.0.1:8765** (on the machine where it runs).

---

## 1. What to give it

| You have | Do this | Result |
|---|---|---|
| **DWG** | Open in AutoCAD → `SAVEAS` → file type **AutoCAD 2018 DXF** (any R2007 or later is fine). One DXF per sheet or one for the whole set, both work. | Translated **DXF** you can open or save back as DWG. |
| **PDF plotted from CAD** (the text is selectable in a PDF reader) | Upload the PDF as it is. | Translated **PDF**. It cannot be turned back into CAD. |
| **Scanned PDF / image** (text not selectable) | Not supported yet. | — |

Sizes up to ~50 MB are fine. A 60-page PDF or a full architecture set takes 10–30 minutes to translate.

## 2. Run a drawing

1. **New drawing** (top right). Choose the file, the **client** and **project** folders (type a new name or pick an existing one), the source and target language. Upload.
2. The job appears in the sidebar under its client/project. Stage 1–2 (inventory, prepare) run at once: you see how many strings were found and how many are unique.
3. Click **Translate**. The stage strip pulses while it runs. Strings the tool has seen before on this client (title block, legends, repeated labels) come "from memory" and cost nothing.
4. When it finishes, the **Review** tab fills in. Everything the model translated cleanly is already ticked as approved.

## 3. Review

One row per unique string. The **×** column says how many places on the drawing that string appears — fix it once, it's fixed everywhere.

- Click a translation to edit it. Edited rows turn yellow; **↺** puts the model's version back.
- Untick a row to leave that string untranslated in the output.
- **Filters**: *Needs attention* shows what a human must check; *Fit flags* shows strings that had to be squeezed.

What the notes mean:

| Note / flag | Meaning | What to do |
|---|---|---|
| **needs a human** | The model's answer was unusable (formatting lost). The original text is kept. | Type the translation yourself, tick approve. |
| **name reading unverified** | A personal name was romanised; the reading can't be verified from the drawing. | Check with the client or the drawing register. |
| **memory** | Reused from an earlier approved job. | Nothing, unless it's wrong — then edit it and it will be relearned when you store the job. |
| **long / tight · w0.8** | English is wider than the original; it was narrowed to 80 % width to fit. | Fine down to about w0.7. Below that, consider a shorter wording. |
| **overflow** | Even at the narrowest readable width it does not fit. | Shorten the translation. |

Grid axes, marks like **ОК-9.1** or **Д-9л**, numbers, model numbers and codes are deliberately left as they are — a reader matches them against the schedules.

## 4. Patch, check, download

1. **Patch & verify** writes the drawing. The strip shows *"… entities · geometry unchanged"*. If it ever says **CHANGED**, stop and tell Allan — don't issue that file.
2. **Preview** tab: *Before* / *After*. Drag a rectangle to zoom in; **Back** goes up a level. PDFs have a page box.
3. **Download DXF/PDF** and open it in AutoCAD or the free **Autodesk Viewer** (viewer.autodesk.com — drag the file in). Look at: title block, tables/schedules, long notes paragraphs, anything that was flagged.
4. **Report** tab lists everything that was written, narrowed, left untranslated, and the token usage.

## 5. Store in memory (do this after review)

When the sheet is reviewed and good, press **Store in memory**. Every approved translation is kept for that language pair and reused verbatim on the next sheets — so a 20-sheet set has an identical title block on every sheet and each later sheet costs less. Don't store a job you haven't looked at.

## 6. Cost

The strip at the top shows the estimated spend **today / this month / all time in ¥**, and each job shows its own cost. It's calculated from the token counts and the prices in `workspaces/pricing.json` — if Anthropic's prices change, edit that file (also the ¥/$ rate).

Rough guide: a plan sheet ≈ ¥100–300, a dense notes sheet ≈ ¥500–1,500, a 60-page PDF ≈ ¥5,000–15,000, before memory savings.

## 7. Making it translate the way we want

The rules live in plain text files under `workspaces/` (there is a "Navigator Workspaces"-style folder on the Desktop for the Navigator app; this tool has its own `drawing-translator/workspaces/`):

- `_references/rules.md` — what never to translate, abbreviations, house style.
- `_references/glossary/ru-en.md`, `ja-en.md`, … — fixed term translations (one per line: `term → translation`). Add the client's preferred wording here.
- `CLAUDE.md` — the standing instructions to the model.

Edit, save, run the next job — no restart needed.

## 8. If something goes wrong

- **Upload refused**: it must be `.dxf` or a vector `.pdf`. DWG must be exported first.
- **A stage shows an error in red**: read it; most often it's a network/API hiccup — press Translate again. Nothing is lost; every stage is a file in the job folder.
- **Job is "busy"**: another step is still running on it. Wait for the strip to stop pulsing.
- **Text looks wrong in the After preview but right in the review table**: the preview uses a substitute font; check in AutoCAD before judging.
- **Japanese output shows boxes in the viewer**: the viewer lacks a Japanese font. AutoCAD with the `extfont2` bigfont shows it correctly.

Questions → Allan.
