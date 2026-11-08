# Cworks Drawing Translator — what it can do

Translates the text on construction drawings between Russian, Japanese and English. It
replaces text and nothing else, and it proves that on every job: every line, arc, block
and dimension is measured before and after, and a job whose geometry moved says so instead
of being handed over.

This is the capability list. [HOW_TO_USE.md](HOW_TO_USE.md) is the guide for driving the
app; [TROUBLESHOOTING.md](TROUBLESHOOTING.md) is every awkward drawing we have diagnosed,
symptom first.

---

## 1. What goes in, what comes out

| You have | You get back |
|---|---|
| **DWG**, any AutoCAD release | Translated **DWG** at the same release, plus the DXF it verified, plus your original |
| **DXF**, R2007 or later | Translated **DXF** |
| **Vector PDF** plotted from CAD (text selectable in a reader) | Translated **PDF**, and on request a second copy with reviewer notes as sticky comments |
| Scanned PDF or image | Nothing. There is no text in it to read, and the job says so rather than coming back empty |

**A DWG comes back as a DWG.** There is nothing to set. Three buttons appear on a DWG job:
**Download DWG** is the one to send on, **Download DXF** is the file the app wrote and
checked, and **Download original** is the client's file exactly as it arrived. The DXF and
the original are what tell you, if a drawing ever looks wrong, whether it happened on the
way in or on the way out.

If converting back to DWG fails, the main button becomes Download DXF and the job page says
so in red. The translation is finished and verified by then, so nothing is lost — the DXF
saves to DWG from AutoCAD in a few seconds.

DWG conversion needs the ODA File Converter on the server. Open `/healthz`: `"dwg": true`
means it is there.

### Languages

The translator handles Russian, Japanese, English, Chinese and Korean.

**The upload form currently offers fewer than that:** source Japanese, Russian or English;
target English or Japanese. Chinese, Korean and Russian-as-a-target are built but not
switched on in the form.

### Size

Up to about 50 MB is comfortable. Measured on the server: a 142 MB set needs about 1.05 GB
of memory and runs 20–40 minutes a stage; a 60-page PDF or a full architecture set takes
10–30 minutes to translate. The page says which, from the file's own size, rather than
telling everyone "a few minutes".

---

## 2. The five stages

Every stage is a file on disk under `jobs/<id>/`, so any stage can be re-run or hand-edited
and nothing is lost to a restart in the middle of a job.

| Stage | What happens |
|---|---|
| **1 Read** | Finds every piece of text in the drawing and measures the room each piece has |
| **2 Prepare** | Reduces it to unique strings, each with its space and a character budget |
| **3 Translate** | Claude, in batches, with the memory and glossary applied first |
| **4 Review** | A person approves, edits or rejects, one row per unique string |
| **5 Patch & verify** | Writes the text back, then proves the geometry did not move |

Then the report, and the download.

---

## 3. Reading the drawing

Text is found in all of these:

- **TEXT** and **MTEXT**, loose or inside blocks
- **Block attributes** (ATTRIB) and **block definitions** (ATTDEF), including constant
  attributes, which AutoCAD draws straight from the definition and never makes an ATTRIB for
- **ACAD_TABLE** cells, *and* the anonymous `*T` block holding the table's drawn copy —
  which is the copy that actually prints
- **DIMENSION**, **ARC_DIMENSION**, **LARGE_RADIAL_DIMENSION** overrides, and the `*D`
  blocks holding their drawn copies
- **MULTILEADER** callouts — the arrow-and-text notes pointing at equipment
- **TOLERANCE** frames

It walks model space, every paper layout by name, and every block. Model and paper space are
themselves blocks, so a naive sweep counts their contents twice; this one does not.

### It tells you what it cannot reach

Two alarms, both added because a real drawing taught us the lesson.

- **"We could not reach these."** An **OLE2FRAME** is a Word or Excel object embedded whole —
  a binary blob plus a picture of itself. An **ACAD_PROXY_ENTITY** is an object from an
  application nobody here has. The words belong to another program and no DXF library can
  rewrite them. Naming them is the point: a table that comes back in Russian should read as
  an explanation, not as a bug.
- **"Please report this drawing."** Anything holding text that we did *not* collect. This is
  the net for the next class of bug. It exists because multileaders were silently skipped on
  every real AutoCAD drawing for months — 589 callouts on one sheet — and nothing said so.

### It tells you what is missing from the file

Drawings pull parts of themselves from other files. The job lists every link it found, and
distinguishes one that merely sat beside the drawing in its own folder — nothing to chase,
it comes back by itself — from a dead path on somebody else's machine.

---

## 4. Making the text fit

The part that decides whether a translated drawing is usable or a mess. Russian runs 20–30%
longer than Japanese, and replacing text without measuring produces overruns everywhere.

Every string is measured in the exact font it will be drawn in, using real advance widths
read out of the TrueType file, against the room geometry gives it: a table cell, the gap to
the next column, the space between two grid lines.

Then, in order:

1. **Re-wrap** over the lines the paragraph has
2. **Narrow the width factor**, never below 0.6 — the floor at which a plot is still readable
3. **Ask again for shorter wording**, within the exact character budget that will fit
4. **Add a line below** where a cell is too narrow for any wording
5. **Pull an MTEXT box in** to the cell it sits in

Only what survives all five is flagged **overflow** for the reviewer, which is rare.

Stacked single-line TEXT entities — how drafters actually write a block of notes — are
recognised as one paragraph from their geometry and translated as a paragraph, not line by
line.

---

## 5. Proving the drawing did not change

Every entity that is not text is counted and fingerprinted at stage 1, and measured again on
the finished file. If anything moved, was resized or disappeared, the job shows **CHANGED**
and the report opens with *do not send this on*.

AutoCAD control codes are masked out of the model's view and put back verbatim, so they
cannot be translated by accident: `%%c` (Ø), `%%d` (°), `%%p` (±), underline and overline,
and `%%nnn` by character code. So is `<>`, the placeholder where AutoCAD substitutes a
measured dimension.

A multileader keeps a cached picture of itself for software that cannot draw the entity.
That picture is dropped when the text is rewritten, or the drawing would show the old
language over the new.

---

## 6. Translating the way this office translates

**Left alone deliberately.** Grid axes and element marks (`ОК-9.1`, `Д-9л`), model numbers,
product codes, numbers. A reader matches those against the schedules, so translating them
destroys the reference.

**Transliterated to standard.** GOST, СП and СНиП references; drawing-set codes (АР → AR,
ОВ → OV).

**Fonts.** SHX and bigfont, vertical text styles, fonts named inline with `\f`, and
full-width characters converted to ASCII where the Latin font cannot draw them. A Japanese
target gets a text style that can show it.

**Memory.** Approved translations are kept per language pair and reused word for word. On a
20-sheet set the title block is identical on every sheet and each later sheet costs less.
Press **Store in memory** after reviewing a sheet. Deleting old jobs costs nothing — the
memory is separate and survives.

**Edit the rules without a deploy.** Under `workspaces/`:

| File | What it holds |
|---|---|
| `_references/rules.md` | What never to translate, abbreviations, house style |
| `_references/glossary/ru-en.md`, `ja-en.md`, … | Fixed terms, one per line: `term → translation` |
| `CLAUDE.md` | The standing instructions to the model |
| `pricing.json` | Token prices and the ¥/$ rate |

Save the file, run the next job. No restart, no deploy.

---

## 7. Review

One row per unique string. The **×** column says how many places that string appears on the
drawing — fix it once and it is fixed everywhere.

- Click a translation to edit it. Edited rows turn yellow; **↺** restores the model's version
- Untick a row to leave that string in the original language
- Filters: **Needs attention** for what a person must decide, **Fit flags** for what had to
  be squeezed

| Note | Meaning |
|---|---|
| **needs a human** | The model's answer was unusable. The original is kept until somebody types one |
| **name reading unverified** | A personal name was romanised and the reading cannot be confirmed from the drawing |
| **from memory** | Reused from an earlier approved job |
| **long / tight · w0.8** | Narrowed to 80% width to fit |
| **shortened to fit** | Re-worded tighter, within the exact room. Reads as drafting shorthand |
| **overflow** | Does not fit even after all of that. Shorten it yourself |

**Flag a sheet yourself.** The app flags what it can measure. A reviewer sees what it cannot
— a label sitting over a door, a note that reads wrongly in English. A flag with a note is
carried into the report so it reaches whoever does the editing.

---

## 8. Looking at it

**Before** and **After** views of the drawing. Drag a rectangle to zoom in; **Back** goes up
a level. Separate sheets inside one model space are found from their own borders; paper
layouts are listed by name; PDFs have a page box.

Previews use substitute fonts, so they tell you where things are, not exactly how wide they
will be. Judge fit in AutoCAD or at viewer.autodesk.com.

---

## 9. Handing it over

**The report** answers one question at the top — *is this ready to send?* — then lists the
sheets worth a glance and what to expect on each. That top half is the part to forward. The
engineering detail is at the bottom for chasing a fault.

**For a PDF**, **Download PDF with notes** gives a second copy carrying a sticky comment on
every page worth a look, a bookmark for each, and a summary sheet at the end. Send the clean
PDF to the client and the annotated one to whoever does the editing. The page numbers match,
because the summary is added at the end rather than the front.

---

## 10. Running the work

- **Client and project folders** in the sidebar
- **Several drawings at once.** They upload together and are read one at a time, because two
  large drawings at once is more memory than the server has. The ones waiting say so
- **Spend**, in yen: today, this month, all time, and per job
- **Archive** a finished job; **trash** keeps a deleted one for 14 days with restore
- **Re-read drawing** re-runs stages 1 and 2 in place after the app improves, keeping the
  translations — so a drawing never has to be paid for twice
- **Unstick** clears a step left claimed by a job the server was restarted under

---

## 11. The help desk

Ask a question about a job and it is answered with that job's own diagnostics to hand, plus
both guides. Adding a case to `TROUBLESHOOTING.md` teaches it — no deploy and no code
change, and staff then get the same answer without asking.

---

## 12. Admin

- **Logins** come from `DXFT_USERS` on the server, one account per line. Never in the repo
- **`/healthz`** is open on purpose and names nothing private: version, how many logins were
  read, whether DWG is available, and the machine's CPU, RAM and peak memory
- **A command line** mirrors the app on the same job folders, with `--mock` to exercise
  inventory, prepare, patch and verify for nothing before spending on the API
- **Tests** under `tests/` cover the upload race and the DWG round trip

---

## 13. What it will not do

- Move, resize or delete geometry. It only changes text, and it checks
- Read a picture of text. A scan holds no text to translate
- Recover text from a linked file that was not sent
- Rewrite words owned by an embedded Word or Excel object
- Turn a PDF back into CAD
