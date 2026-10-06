# Drawing Translator — when a drawing misbehaves

Symptom first. Each entry says what you are looking at, why it happens, and what to do.
Most of these are not faults in the app. They are things drafters do that the app has to
cope with, and knowing which is which saves a lot of time.

Read section A before asking for help. It answers most questions on its own.

---

## A. Three facts that explain most surprises

**1. A drawing is not just what you see in model space.**
Text can be stored inside blocks, which are reusable stamps placed on the sheet. On one
job, 3,068 of the 3,242 pieces of text were inside blocks and only 174 were loose on the
sheet. This is normal. It is why the app reports far more text than you might expect from
looking at the drawing.

**2. A table keeps two copies of itself.**
A CAD table holds its cell values, and it also holds a drawn copy of itself. The drawn
copy is the one that prints. If a table looks untranslated in the output while the review
table shows it was translated, the app translated the values and not the drawn copy. The
fix for this shipped on 29 September. Use **Re-read drawing** on any job older than that,
then re-translate.

**3. A text box is often much wider than the cell it sits in.**
Text in CAD can carry a box that tells it where to wrap. Drafters copy one piece of text
across a whole row of narrow cells, and the box keeps the width of the entire row. The
original language is short enough never to reach that width, so nobody notices. A longer
translation wraps at the box instead of at the cell, and runs straight through the cell
wall into the column beside it. On one title block, a third of the boxed text had a box
wider than its cell. The app now measures the cell and holds the box to it.

---

## B. Something is wrong with the output

### Text runs into the next column, or sits on top of other text

In order, the app does three things to make a translation fit: shortens the wording,
narrows the letters by up to 40 per cent, and wraps onto the next line down. It only does
this where it can measure the space. It measures by looking for the nearest thing to the
right: another piece of text, or a cell wall.

Check first whether the original was already overflowing. Open the Before preview at the
same spot. Drafters routinely let text run slightly past its own cell wall, and on one
Russian set the original did this in 226 places. Where the original overlapped, the
translation will too, and that is not something the app introduced.

If the original was clean and the English is not, use **Report a problem**. That is a real
fault and it needs measuring, not guessing.

### Before and After show different parts of the drawing

They should always show the same region, so this looks alarming. Until 6 October
2026 it could happen for a dull reason: pictures were filed under the word
"overview" rather than under the part of the drawing they showed, so after a
**Re-read drawing** one side could still be serving the picture drawn for the
previous reading. Nothing was wrong with the drawing or the output.

It is fixed. On a job that still shows it, drag a rectangle over the same area in
both views: that path was never affected and the two will agree.

**Geometry is checked separately and does not depend on the pictures at all.** If
stage 5 says `geometry unchanged`, nothing was moved, resized or deleted,
whatever the previews happen to show.

### A sheet comes back blank, or nearly blank

Almost always the sheet is blank in the source as well. Sheets have windows onto the
drawing, and a window can be switched off. On one job, 41 of the 46 sheets had every
window switched off. They were blank before translation and blank after.

This is usually produced by the DWG to DXF export, not by the drafter. Ask whoever sent
the file to re-export from DWG, and to check the sheets look right in the DXF before
sending it. Opening their DWG in the free Autodesk viewer tells you in a minute whether
the content is there.

### Lots of the original language is still showing

Three different causes, and they look identical on screen.

- **It is a picture, not text.** Scanned or traced drawings hold no text at all, only an
  image of text. There is nothing for the app to read. Check the inventory count: a
  drawing with almost no text is a scan. These cannot be translated by this tool.
- **It came from a linked file.** Drawings often pull parts of themselves from other
  files. If those files were not sent with the drawing, the app cannot read or translate
  them. The job page lists which links it found.

  **A link that sits beside the drawing is nothing to chase.** The picture never left the
  folder the drawing came from, so it is blank here and comes back by itself once the
  translated drawing is put back in that folder, which is how the drawing is returned as
  DWG anyway. Only a path on another machine — `C:\Users\...`, `\\server\...` — is worth
  a look, and usually only to confirm it has been dead for years. On one job, 28 of 34
  links were that kind.
- **The job predates a fix.** Use **Re-read drawing**, then re-translate. Nothing is lost.

### A small box of text sits in the bottom right of every page

That is a stamp block placed outside the sheet frame. It is in the original too. Check the
Before preview at the same spot to confirm, then ignore it.

### The same term is translated differently on different sheets

Each sheet is translated on its own, so wording can drift. Fix it once: correct the term in
the review table, approve it, then press **Store in memory**. Every later sheet on that
project reuses the stored wording. Do this at the end of the first sheet of a set and the
rest of the set comes back consistent.

### Characters show as hollow boxes

The viewer has no font for them. Check in AutoCAD before judging the output. This is a
viewer limitation, not a translation fault.

---

## C. Something is wrong with the app

### A stage has said "working" for a long time

Large sheets take several minutes to translate. Drawing a preview of a big drawing takes a
minute or two per sheet. The progress bar reports the stage it is on, and the Help dialog
can read the job's own diagnostics, including how long the stage has actually been
running. Check that before deciding anything is stuck.

If a stage is genuinely hung, press **Unstick**. It clears the stage without losing any
work, and you can run it again.

### An upload seemed not to happen

The upload has its own progress bar. If it filled and nothing appeared, the file is
probably still being read. Wait rather than uploading again. Repeated uploads of the same
drawing create duplicate jobs, which is the commonest cause of confusion on a busy day.

### A stage shows a red error

Read it. Most are network or API hiccups. Press the stage again. Nothing is lost, because
every stage is a saved file in the job folder.

### I deleted a job by mistake

Deleted jobs go to the trash and stay there for 14 days. Restore it from the trash. If you
deleted it and immediately regret it, the undo notice at the bottom of the screen brings it
straight back.

### I want the app to translate a term our way

Put it in the project's memory, as described above. Do not fix the same term sheet by
sheet.

---

## D. What to do before asking for help

1. Open the **Before** preview at the same place as the problem and look at the original.
   This separates "the app did this" from "the drawing was always like this", and it
   settles most questions.
2. Ask the **Help** dialog on the job. It can see the job's real numbers: stage, elapsed
   time, text counts, sheets found, links reached, how many strings overflowed.
3. If it is a fault in the tool, press **Report a problem**. It packages the diagnostics
   for the developer. A screenshot plus the drawing file is worth more than a description,
   and the file is what makes a fix possible.

## E. What the app will not do

It does not move, resize or delete any geometry. It only changes text, and it checks the
geometry is untouched after every patch. If the check reports a change, that is reported
on the job and should be sent on.

It does not translate pictures of text, and it cannot recover text from a file that was
never sent.

### A PDF page comes back with text smeared across it and most cells empty

CAD plotters sometimes write a whole column of table text as one instruction
in the PDF, placing each character by hand. Read literally, that is one long
string made of unrelated cells, and writing a translation back put it in one
place and blanked the rest. Fixed on 5 October 2026: the app now reads a PDF
by where each character actually sits.

If you see this on a job started before that date, use **Re-read PDF**, then
re-translate, approve, and patch again. There is no need to upload again.

### A PDF looks like it only has one page

It does not. Above the preview is **Page ‹ [1 of 34] ›**. Use the arrows or
pick from the list. Every page of the PDF is translated, whichever one you
happen to be looking at.

### Which pages still need a look

Three places say so, and they agree with each other:

- **The review table** has a **Where** column. Click the page number and the
  preview opens there.
- **The page list** above the preview marks them: *"12 of 34 — 1 to check"*,
  with a count of how many pages are marked.
- **The report** ends with **Pages to look at**, naming each page and what to
  expect on it. That is the page to send to whoever does the DWG edits.

### Flagging a page yourself

The app marks what it can measure. It cannot see a label sitting over a door
swing or a note that reads oddly in English. When you spot one, press
**⚑ Flag this page** above the preview and type what to look at. The page is
then marked in the page list like any other, and the report says:

> **page 19** — flagged by the reviewer: room name sits over the door swing

That is how something you noticed reaches whoever does the editing. Press the
button again and clear the note to remove the flag.

### "Too long" and "squeezed to fit"

English is usually longer than Japanese or Russian, so the app measures the
room each piece of text has and makes it fit: it wraps onto the lines
available, then narrows the letters, never past the point where they stop
being readable.

A row says one of two things, or nothing at all:

- **too long** — it still does not fit, even narrowed as far as is allowed.
  This is the only one that wants you. Click the translation and write it
  shorter. The **Too long** filter shows just these.
- **squeezed to fit** — it fits, but the letters were narrowed to get there.
  Nothing to do. Worth knowing when you look at the sheet.
- **nothing** — it fits.

Both are written into the drawing either way. Neither is an error.

### Getting the notes to the engineers

The engineers get the PDF, not the app. So the notes go into the PDF.

**Download PDF with notes** gives you the same translated drawing with:

- a yellow sticky note in the corner of every page worth a look, holding the
  note you wrote and anything the app flagged
- a bookmark for each of those pages, so they can be stepped through
- a summary sheet at the end listing every one

Any PDF reader shows these. In Acrobat or Preview the comments panel lists
them all and clicking one jumps to that page, which is the quickest way for
someone to work through them.

**Download PDF** stays exactly as it was: the clean, verified drawing with no
notes on it. Send that one to the client. Send the one with notes to whoever
is doing the editing. Page numbers are the same in both, because the summary
sheet is added at the end rather than the front.

### What the report is for

Press **Report** and read the top. It answers one question: is this ready to
send? Then it lists the pages worth a glance and what to expect on each. That
top half is the part to forward. The rest is detail for chasing a fault.

A page is marked when something on it is still too long for its space, was
not approved, the model was unsure of it, or you flagged it. Everything is written into the
drawing either way. These are places worth a glance before it goes out, not
errors.

On a DXF, text held in a block is named as a block rather than a sheet,
because a block can sit on several sheets and naming one would be a guess.
