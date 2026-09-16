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
---

# Stage 03 · Translate

You receive a JSON list of drawing strings. Each has an id, the text (with ⟦n⟧ markers where formatting codes were), a context (the layer names it appears on), its entity kind, and whether it is set vertically.

Process
1. Read the glossary and the rules first. They win over your own preference.
2. Translate each string as a drafter would write it: short, standard terms, same line structure.
3. Keep every ⟦n⟧ marker. Place it where the formatting change belongs in the translation (usually the same relative position).
4. Leave protected content untouched inside the string: numbers, units, codes.

Output shape
A single JSON object: {"s00001": "translation", "s00002": "translation", ...}. Nothing before or after it.
