# Rules for drawing text

## Keep as-is (do not translate)
- Dimension values, elevations (+0.000, FL+1,200), angles, percentages
- Units: mm, m, m², kg, kN, MPa, V, A, W, kW, Hz, φ, Ø, DN, PN
- Codes: sheet numbers (E-01, A-101), detail references (1/A-5), grid lines (X1, Y2, ①), room numbers, equipment tags (AC-1, P-2, EF-3), cable types (CV, IV, EM-CE), circuit numbers, model numbers, standards (JIS C 8305, ГОСТ 21.101-97, ГОСТ 2.304)
- Latin-script company and product names
- Special AutoCAD codes: %%C (diameter), %%D (degree), %%P (plus-minus), %%U (underline)

## Russian drawing references (keep exactly as written)
- Grid axes (А, Б, В, 1, 2), stair and legend keys (Л1, Ст2), and element marks that point to a schedule — windows ОК-9.1, doors Д-9л, openings ПР-1, Ш-7 — stay in Cyrillic, unchanged, wherever they appear ("Фасад Д-А" → "Elevation Д-А"). A reader matches them against the schedule on the same sheet.

## Translate consistently
- Use the glossary. A term translated one way in the title block is translated the same way in the notes.
- Japanese full-width Latin letters and digits (ＡＢＣ１２３) become half-width (ABC123) in English output.
- Japanese "〜" ranges become "to" or "–" in English; "※" notes become "Note:".
- Russian "см." becomes "see"; "прим." becomes "note"; "поз." becomes "item".

## Title blocks and cover sheets
- Company names: keep the registered English name if one exists in the glossary; otherwise romanise.
- Licence numbers and registration numbers: keep the number; translate the label ("一級建築士事務所 登録54205号" → "First-Class Registered Architect Office, Reg. No. 54205"; when the cell is small, "1st-Class Architect Office Reg. No. 54205").
- Addresses: romanise in Japanese order for English targets (Chiyoda-ku, Tokyo).
- Personal names are romanised in full, surname first as on the drawing ("永瀬 優暁" → "Nagase Yuaki"). Never shorten a name to an initial to save space; the layout step narrows the text instead.
- Table rows written as one string with padding ("計画名称      五反田プロジェクト") keep a run of spaces between label and value; the exact count does not matter, it is re-aligned afterwards.

## Room names and numbered labels
- Room names are written in full: Corridor, Storage, Garage, Utility Room, Server Room, Shower, External Stair, Internal Stair. Never clip them to "Cor", "Sto", "St".
- A numbered label keeps the number in the same form with one space before the bracket: 廊下(1) → "Corridor (1)", ガレージ(2) → "Garage (2)". The same word gets the same form everywhere on the sheet.
- 既存 / 既設 → "Existing" (Ex. only when max_chars forces it); 新設 → "New".

## Length
- Prefer the shorter of two correct translations. Drawing space is fixed.
- Standard abbreviations are welcome where a drafter would use them: FL, CL, GL, EL, RF, EPS, PS, DS, W/ , W/O, TYP., DIA., THK., EQUIP., INSTL., REG. NO., BLDG., ELEC., MECH., EMERG., DIST. BD. (distribution board), SUBSTA. (substation).
- Section headings on notes sheets ("2）幹線設備") keep the number and use the short noun form: "2) Main Feeders", not "2) Main Feeder Installation".
- A paragraph typed as N stacked lines is translated as one paragraph and must fit back into N lines of the same width. Write tight.
