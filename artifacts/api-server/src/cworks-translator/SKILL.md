---
name: cad-doc-translator
description: Translate positioned text in construction and engineering PDF drawings while preserving the source pages.
---

# CAD Document Translator

## Purpose
Produce an English working translation of a construction/engineering PDF while retaining the source PDF page geometry, vector drawings, dimensions, linework, and sheet order.

## Method
1. Inspect every page and extract text as positioned line blocks with page coordinates and source font size.
2. Translate human-language drawing text only. Preserve drawing numbers, dimensions, model numbers, revision codes, abbreviations without a confident expansion, and standards references.
3. Use the project glossary when supplied. For ambiguous abbreviations, keep the abbreviation and record it in the summary rather than inventing a meaning.
4. Replace source text in its original bounding area. Remove text only; do not rasterize, flatten, or delete vector line art and images.
5. Fit English text conservatively inside the original area. Use a white backing only where required for readability.
6. Render every translated page to an image and visually review for missing text, overflow, and placement problems.
7. Return an editable review checkpoint before the PDF is considered approved.

## Coverage modes
- `major-text`: translate title blocks, headings, legends, schedules, callouts, notes, room/area labels, and meaningful annotations; skip tiny incidental text.
- `everything`: translate every detected human-language text line while preserving pure codes/numbers.

## Safety
- Never claim the output is a certified translation.
- Never change measurements, quantities, drawing references, sheet identifiers, or revision codes.
- If a line cannot be translated confidently, retain the source line and report it as a warning.
- Source files, extracted text, translations, and rendered pages are confidential project data and must not be written to general application logs.