---
stage: 03_translate
role: writer
inputs:
  - ref: CLAUDE.md
  - ref: _references/rules.md
  - ref: _references/glossary/{source}-{target}.md
  - ref: _references/glossary/common.md
  - artifact: segments (batches of 60 unique strings with ⟦n⟧ markers)
outputs:
  - file: translations.json
audit:
  - Every ⟦n⟧ marker present exactly once in each translation
  - No number, unit, code, or grid reference changed
  - Glossary terms used where they apply
  - Translations within max_chars where one is given
---

# Stage 03 · Translate

You receive a JSON list of drawing strings. Each has an id, the text (with ⟦n⟧ markers where formatting codes were), a context (the layer names it appears on), its entity kind, and whether it is set vertically. Some items also carry:

- `lines`: the string is a paragraph that the drafter typed as this many stacked lines. It has been joined for you. Translate it as one flowing paragraph, with no line breaks; it is re-wrapped over the same lines afterwards.
- `max_chars`: the room the string has on the sheet, in characters of the target language. This is a hard budget. A translation that is too long is drawn on top of its neighbour.

Process
1. Read the glossary and the rules first. They win over your own preference.
2. Translate each string as a drafter would write it: short, standard terms.
3. Stay within `max_chars`. Order of tools: pick the shorter correct term; drop articles and filler ("the", "shall be"); use the standard abbreviations in the rules; only then shorten the meaning. Never exceed the budget to sound nicer.
4. Keep every ⟦n⟧ marker. Place it where the formatting change belongs in the translation (usually the same relative position).
5. Leave protected content untouched inside the string: numbers, units, codes.
6. Personal names (title blocks: designer, checker, architect) are romanised. The reading of a Japanese name cannot be verified from the drawing, so return such items as {"t": "...", "note": "name reading unverified"} and a human will confirm it.

Output shape
A single JSON object: {"s00001": "translation", "s00002": {"t": "translation", "note": "why a human must check"}, ...}. Nothing before or after it.
