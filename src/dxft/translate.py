"""Stage 3 · Translate.

Send unique segments to Claude in batches with the rules and glossary from
workspaces/, get a strict id -> translation mapping back, and verify that
every ⟦n⟧ marker survived. Segments whose markers were lost are retried
once on their own; if they still fail, they are flagged for the reviewer
and left untranslated rather than patched badly.

A `MockTranslator` exists so the whole pipeline can be exercised without
an API key: it wraps each string as [XX] source [/XX] so round-tripping is
visibly verifiable in the output drawing.
"""
from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol

from .prepare import Segment, MARK_RE

WORKSPACES = Path(os.environ.get("DXFT_WORKSPACES", Path(__file__).resolve().parents[2] / "workspaces"))
DEFAULT_MODEL = os.environ.get("DXFT_MODEL", "claude-opus-5")
BATCH = int(os.environ.get("DXFT_BATCH", "60"))

LANG_NAME = {"ru": "Russian", "ja": "Japanese", "en": "English", "zh": "Chinese", "ko": "Korean"}


@dataclass
class Translation:
    id: str
    target: str
    ok: bool = True
    note: str = ""   # why it needs attention


class Translator(Protocol):
    def translate(self, segments: list[Segment], source: str, target: str) -> list[Translation]: ...


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8") if path.exists() else ""


def build_system(source: str, target: str) -> str:
    """Layer 0 + rules + glossary for this language pair, cached by the API."""
    parts = [
        _read(WORKSPACES / "CLAUDE.md"),
        _read(WORKSPACES / "_references" / "rules.md"),
        _read(WORKSPACES / "_references" / "glossary" / f"{source}-{target}.md"),
        _read(WORKSPACES / "_references" / "glossary" / "common.md"),
        _read(WORKSPACES / "translate" / "stages" / "03_translate" / "CONTEXT.md").split("\n---\n", 2)[-1],
    ]
    return "\n\n".join(p.strip() for p in parts if p.strip())


def markers_ok(source: str, target: str) -> bool:
    return sorted(MARK_RE.findall(source)) == sorted(MARK_RE.findall(target))


class ClaudeTranslator:
    def __init__(self, model: str = DEFAULT_MODEL):
        from anthropic import Anthropic  # imported lazily so mock mode needs no key
        self.client = Anthropic()
        self.model = model
        self.usage = {"input": 0, "output": 0, "cache_read": 0, "cache_write": 0}

    def _call(self, system: str, user: str) -> str:
        resp = self.client.messages.create(
            model=self.model,
            max_tokens=16000,
            system=[{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}],
            messages=[{"role": "user", "content": user}],
        )
        u = resp.usage
        self.usage["input"] += u.input_tokens
        self.usage["output"] += u.output_tokens
        self.usage["cache_read"] += getattr(u, "cache_read_input_tokens", 0) or 0
        self.usage["cache_write"] += getattr(u, "cache_creation_input_tokens", 0) or 0
        if resp.stop_reason == "refusal":
            raise RuntimeError("model refused the batch")
        return "".join(b.text for b in resp.content if b.type == "text")

    @staticmethod
    def _parse(text: str) -> dict[str, tuple[str, str]]:
        """id -> (translation, note). A value may be a string or {"t": ..., "note": ...}."""
        text = text.strip()
        text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text)
        start, end = text.find("{"), text.rfind("}")
        data = json.loads(text[start:end + 1])
        out: dict[str, tuple[str, str]] = {}
        for k, v in data.items():
            if isinstance(v, dict):
                out[str(k)] = (str(v.get("t") or v.get("text") or ""), str(v.get("note") or ""))
            else:
                out[str(k)] = (str(v), "")
        return out

    def translate(self, segments: list[Segment], source: str, target: str) -> list[Translation]:
        system = build_system(source, target)
        out: list[Translation] = []
        for i in range(0, len(segments), BATCH):
            batch = segments[i:i + BATCH]
            out.extend(self._translate_batch(batch, source, target, system))
        return out

    def _translate_batch(self, batch: list[Segment], source: str, target: str, system: str, retry: bool = True) -> list[Translation]:
        payload = []
        for s in batch:
            item = {"id": s.id, "text": s.source, "context": s.context, "kind": s.kinds[0], "vertical": s.vertical}
            if s.lines > 1:
                item["lines"] = s.lines
            if s.budget_chars:
                item["max_chars"] = s.budget_chars
            payload.append(item)
        user = (
            f"Source language: {LANG_NAME.get(source, source)}. Target language: {LANG_NAME.get(target, target)}.\n"
            f"Translate the \"text\" of every item. Return ONLY a JSON object mapping id to translated text "
            f"(or to {{\"t\": text, \"note\": why}} when a human must check it), "
            f"with every ⟦n⟧ marker kept exactly, in a sensible position.\n\n{json.dumps(payload, ensure_ascii=False)}"
        )
        mapping: dict[str, tuple[str, str]] = {}
        try:
            mapping = self._parse(self._call(system, user))
        except Exception as ex:
            if retry and len(batch) > 1:
                half = len(batch) // 2
                return self._translate_batch(batch[:half], source, target, system) + self._translate_batch(batch[half:], source, target, system)
            return [Translation(s.id, s.source, ok=False, note=f"model error: {ex}") for s in batch]

        results: list[Translation] = []
        redo: list[Segment] = []
        for s in batch:
            t, note = mapping.get(s.id, ("", ""))
            t = _clean(t, target)
            if s.kinds and s.kinds[0] in ("TEXT", "ATTRIB"):
                t = _repad(s.source, t)
            if not t.strip():
                redo.append(s)
            elif not markers_ok(s.source, t):
                redo.append(s)
            else:
                results.append(Translation(s.id, t, note=note or _name_note(source, s.source)))
        if redo and retry:
            for s in redo:
                results.extend(self._translate_batch([s], source, target, system, retry=False))
        elif redo:
            for s in redo:
                t, _ = mapping.get(s.id, ("", ""))
                results.append(Translation(s.id, t or s.source, ok=False, note="missing or markers lost; needs a human"))
        return results


def _clean(t: str, target: str) -> str:
    """Normalise whitespace for non-CJK targets: ideographic spaces become
    spaces and ends are trimmed. Internal runs of spaces are kept: they are
    column padding in table rows (see _repad)."""
    if target in ("ja", "zh"):
        return t.strip()
    t = t.replace("\u3000", " ")
    return "\n".join(line.strip() for line in t.split("\n")).strip()


TABLE_GAP = re.compile(r"[ \u3000]{3,}")


def _repad(source: str, target: str) -> str:
    """A table row is 'label<padding>value' in one string; the padding puts the
    value in its column. Re-pad the translation so its value starts at the same
    visual offset as the source's, whatever the translated label's width."""
    from .layout import em_width
    space_w = em_width("| |") - em_width("||")
    source, target = source.rstrip(), target.rstrip()
    ms = list(TABLE_GAP.finditer(source))
    if not ms:
        return target
    parts = TABLE_GAP.split(target)
    if len(parts) != len(ms) + 1:
        return target
    out, pos, spos = parts[0], em_width(parts[0]), 0.0
    for m, nxt in zip(ms, parts[1:]):
        spos = em_width(source[:m.end()])       # where the next column starts in the source
        gap = max(1, round((spos - pos) / space_w))  # spaces needed to reach it
        out += " " * gap + nxt
        pos = em_width(out)
    return out


# Personal names on a Japanese drawing: 1-3 kanji, a space, 1-3 kanji, as a
# whole token. The reading cannot be verified from the drawing.
JA_NAME = re.compile(r"(?<![一-鿿])[一-鿿]{1,3}[ \u3000][一-鿿]{1,3}(?![一-鿿])")


def _name_note(source_lang: str, source: str) -> str:
    return "name reading unverified" if source_lang == "ja" and JA_NAME.search(source) else ""


class MockTranslator:
    """No API. Wraps text so the round trip is visible in the drawing."""
    usage = {"input": 0, "output": 0, "cache_read": 0, "cache_write": 0}

    def translate(self, segments: list[Segment], source: str, target: str) -> list[Translation]:
        tag = target.upper()
        out = []
        for s in segments:
            pieces: list[str] = []
            pos = 0
            for m in MARK_RE.finditer(s.source):
                chunk = s.source[pos:m.start()]
                pieces.append(f"[{tag}]{chunk}[/{tag}]" if chunk.strip() else chunk)
                pieces.append(m.group(0))  # marker verbatim
                pos = m.end()
            chunk = s.source[pos:]
            pieces.append(f"[{tag}]{chunk}[/{tag}]" if chunk.strip() else chunk)
            out.append(Translation(s.id, "".join(pieces)))
        return out


def get_translator(mode: str, model: str | None = None) -> Translator:
    if mode == "mock":
        return MockTranslator()
    _load_env()
    return ClaudeTranslator(model or DEFAULT_MODEL)


def _load_env() -> None:
    """Read ~/.config/dxft/env (KEY=value lines) so a key never has to be pasted."""
    if os.environ.get("ANTHROPIC_API_KEY"):
        return
    p = Path.home() / ".config" / "dxft" / "env"
    if p.exists():
        for line in p.read_text().splitlines():
            if "=" in line and not line.strip().startswith("#"):
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"'))
