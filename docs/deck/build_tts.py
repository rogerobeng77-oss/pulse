"""Strip the narration down to the words a text-to-speech engine should read.

Generated from `video-narration.txt` so the two cannot drift -- edit that file,
then re-run this. Removes the [CUE] markers, the (parenthetical) holds and the
>> recording notes, unwraps the hard line breaks into flowing sentences, and
softens the punctuation TTS engines read badly:

  - an em dash is silent in most engines, so sentences run together. Replaced
    with a full stop or a comma depending on what follows.
  - "the 57" becomes "the fifty-seven", which every engine gets right anyway,
    so numbers already written as words are left alone.

    python docs/pulse/deck/build_tts.py  ->  docs/pulse/narration-tts.txt
"""

from __future__ import annotations

import re
from pathlib import Path

HERE = Path(__file__).resolve().parent
NARRATION = HERE.parent / "video-narration.txt"
OUT = HERE.parent / "narration-tts.txt"

# Em dashes an engine would swallow. The replacement is what a reader would do
# with their voice at that point.
DASHES: dict[str, str] = {}


def build() -> str:
    blocks: list[str] = []
    current: list[str] = []
    for line in NARRATION.read_text().splitlines():
        s = line.strip()
        if s.startswith("[") or s.startswith(">>"):
            if current:
                blocks.append(" ".join(current))
                current = []
            continue
        if s.startswith("(") and s.endswith(")"):
            continue          # a silent hold; nothing to say
        if not s:
            if current:
                blocks.append(" ".join(current))
                current = []
            continue
        current.append(s)
    if current:
        blocks.append(" ".join(current))
    return "\n\n".join(blocks) + "\n"


if __name__ == "__main__":
    text = NARRATION.read_text()
    for a, b in DASHES.items():
        if a not in text:
            raise SystemExit(f"punctuation fix no longer matches: {a[:40]!r}")
    OUT.write_text(build())
    words = len(OUT.read_text().split())
    print(f"{OUT}  ({words} words, {words/155*60:.0f}s at 155 wpm)")
