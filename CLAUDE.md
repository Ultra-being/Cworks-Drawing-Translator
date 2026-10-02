# Cworks Drawing Translator (dxft)

Translates the text of construction drawings between Japanese, Russian and English
without touching geometry. Run as a managed service: staff upload a drawing, review the
translations, download the result. Live at cworks-drawing-translator.onrender.com.

## Where things are

| Path | What | Who touches it |
|---|---|---|
| `workspaces/` | What the model is told: translation rules, memory of agreed wording per language pair. Plain markdown and JSON. **Editing here changes translations without a deploy.** | Founder and operators |
| `HOW_TO_USE.md` | How staff drive the app | Founder and operators |
| `TROUBLESHOOTING.md` | Every awkward drawing we have diagnosed, symptom first. **The in-app help desk reads this.** Adding to it teaches the help desk with no deploy. | Founder and operators |
| `src/dxft/inventory.py` | Reads the drawing: what text is in it, where, and what is beside it | Developers |
| `src/dxft/layout.py` | Measures space and decides how a string wraps and narrows | Developers |
| `src/dxft/prepare.py` | Turns text into segments the model sees, each with its room and budget | Developers |
| `src/dxft/patch.py` | Writes the translation back, then verifies no geometry moved | Developers |
| `src/dxft/preview.py` | Finds the sheets and draws before/after images | Developers |
| `src/dxft/web.py`, `static/` | The app staff use | Developers |

## Rules for anyone editing with an AI assistant

1. **Measure the finished DXF. Do not judge from a render or a screenshot.** Previews use
   substitute fonts and lie about width. Every claim about fitting must come from reading
   the output file.
2. **Compare against the untranslated input, so only our delta counts.** Drafters let text
   overrun its own cells all the time. On one Russian set the original crossed a cell wall
   in 226 places. Fixing what was already broken is not the job, and counting it hides
   whether the change helped.
3. **Ask for the drawing at the first failure, not the fourth.** Sheet detection was tuned
   three times on guesses and broke on the next file each time. It was settled in one pass
   by reading an actual file. A screenshot says something is wrong; only the file says why.
4. **A drawing is not just model space.** Text lives in blocks, and model and paper space
   are themselves blocks, so naive iteration counts them twice. A table keeps a drawn copy
   of itself in an anonymous `*T` block and that copy is what prints. Any change to reading
   or writing text must be tested on a drawing whose text is in blocks as well as one whose
   text is loose.
5. **`--mock` exercises inventory, prepare, patch and verify for free.** Use it before
   spending anything on the API. `dxft --jobs /tmp/x run file.dxf --source ja --target en
   --mock`. Check `verified` and `problems` in the patch line.
6. **Never deploy while a translation is running.** A restart kills the job and the work is
   lost. Ask first. This has cost real work twice.
7. **Secrets stay where they are.** The API key lives in `~/.config/dxft/env` on the
   founder's machine; app logins live only in Render's dashboard as `DXFT_USERS`. Never ask
   for a password, never put one in a file, never commit either.
8. **When a drawing teaches you something, write it into `TROUBLESHOOTING.md`.** That is
   what makes the next one cost a write-up instead of another investigation, and it is how
   staff get the same answer without asking.
9. One change, one commit. Say what and why, and what you checked.

## Voice for anything written here or in the guides

Direct. Short sentences. Active voice. No hype. Staff reading `TROUBLESHOOTING.md` are
engineers and operators, not programmers: name the button, say what to expect.
