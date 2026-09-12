"""Turn the narration into a recording script you can actually read from.

The Transmission builder, in Pulse's own palette.

Two columns: what is on screen, and what you say over it. Generated rather than
written by hand, because the narration gets rewritten and a script that drifts
from it is worse than no script -- you find out during the take.

It also times every beat at a measured reading speed and marks the point where
the three-minute cap lands, since only the first three minutes are judged.

Run: python docs/pulse/deck/build_script.py
"""

from __future__ import annotations

import html
import re
from pathlib import Path

HERE = Path(__file__).resolve().parent
NARRATION = HERE.parent / "video-narration.txt"
OUT = HERE / "script.html"

# Words per minute for an unhurried demo read. Measured against the Cutaway
# recording rather than guessed; a brisk read is nearer 165 and leaves no room
# to breathe between beats.
WPM = 155.0
CAP = 180.0  # seconds that get judged


def beats() -> list[dict]:
    """Split the narration into (cue, spoken text) pairs."""
    out: list[dict] = []
    current: dict | None = None
    for line in NARRATION.read_text().splitlines():
        stripped = line.strip()
        if stripped.startswith("[") and stripped.endswith("]"):
            current = {"cue": stripped[1:-1], "lines": [], "pending": False}
            out.append(current)
        elif current is None:
            continue
        elif stripped.startswith(">>"):
            current["pending"] = True
            current["lines"].append(stripped.lstrip("> ").strip())
        elif stripped.startswith("(") and stripped.endswith(")"):
            current["lines"].append(stripped)
        elif stripped:
            current["lines"].append(stripped)
    return out


def shot_for(cue: str) -> str | None:
    """The slide image for a cue, when the cue names one."""
    match = re.match(r"SLIDE (\d+)", cue)
    return f"../shots/deck-{int(match.group(1)):02d}.png" if match else None


def build() -> str:
    rows, clock = [], 0.0
    crossed = False
    for beat in beats():
        spoken = " ".join(l for l in beat["lines"]
                          if not l.startswith("(") and not beat["pending"])
        words = len(spoken.split())
        seconds = words / WPM * 60
        start = clock
        clock += seconds
        over = clock > CAP and not crossed and words
        if over:
            crossed = True
        shot = shot_for(beat["cue"])
        body = (f'<p class="pending">{html.escape(" ".join(beat["lines"]))}</p>'
                if beat["pending"]
                else "".join(f"<p>{html.escape(l)}</p>" for l in beat["lines"]))
        rows.append(f'''
      <tr{' class="cap"' if over else ""}>
        <td class="cue">
          <b>{html.escape(beat["cue"])}</b>
          <span>{fmt(start)} → {fmt(clock)}</span>
          {f'<img src="{shot}" alt="">' if shot else ""}
        </td>
        <td class="say">{body}<em>{words} words · {seconds:.0f}s</em></td>
      </tr>''')
    return TEMPLATE.format(rows="".join(rows), total=fmt(clock),
                           over="over" if clock > CAP else "under",
                           cap=fmt(CAP), wpm=int(WPM))


def fmt(seconds: float) -> str:
    return f"{int(seconds // 60)}:{int(seconds % 60):02d}"


TEMPLATE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pulse — recording script</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800&family=IBM+Plex+Mono:wght@400;700&display=swap" rel="stylesheet">
<style>
  :root {{
    --ground:#fff; --surface:#f7f8fa; --line:#e3e6ec; --ink:#161a25;
    --ink-2:#5a6273; --ink-3:#8c94a6; --accent:#3730a3; --accent-soft:#ede9fe;
    --broken:#cf1f1f; --broken-bg:#fdeeee; --watch:#d98008; --watch-bg:#fdf3e3;
  }}
  * {{ box-sizing:border-box }}
  body {{ margin:0; background:var(--surface); color:var(--ink);
    font:400 15px/1.6 Inter, system-ui, sans-serif; }}
  header {{ background:linear-gradient(115deg,#241d63,#4338ca); color:#fff;
    padding:26px 34px; border-top:7px solid #a9a3dd; }}
  header h1 {{ margin:0 0 6px; font-size:22px; font-weight:800; letter-spacing:-.02em }}
  header p {{ margin:0; color:#c8c4ee; font-size:13.5px }}
  header b {{ color:#fff }}
  main {{ padding:24px 34px 70px; max-width:1220px }}
  table {{ width:100%; border-collapse:collapse; background:var(--ground);
    border:1px solid var(--line); border-radius:10px; overflow:hidden }}
  td {{ padding:18px 20px; border-bottom:1px solid var(--line); vertical-align:top }}
  tr:last-child td {{ border-bottom:0 }}
  td.cue {{ width:330px; background:var(--surface); border-right:1px solid var(--line) }}
  td.cue b {{ display:block; font:700 11px/1.4 'IBM Plex Mono',monospace;
    letter-spacing:.06em; color:var(--accent) }}
  td.cue span {{ display:block; margin:5px 0 10px; font:400 12px/1 'IBM Plex Mono',monospace;
    color:var(--ink-3) }}
  td.cue img {{ width:100%; border:1px solid var(--line); border-radius:6px; display:block }}
  td.say p {{ margin:0 0 12px; font-size:16.5px; line-height:1.62 }}
  td.say p:last-of-type {{ margin-bottom:10px }}
  td.say em {{ font-style:normal; font:400 11.5px/1 'IBM Plex Mono',monospace; color:var(--ink-3) }}
  p.pending {{ background:var(--watch-bg); border:1px solid #e9c98a; color:#5c3600;
    border-radius:8px; padding:12px 14px; font-size:14px !important }}
  tr.cap td {{ border-top:3px solid var(--broken) }}
  tr.cap td.cue::after {{ content:"three-minute cap falls here";
    display:block; margin-top:10px; font:700 10.5px/1.4 'IBM Plex Mono',monospace;
    color:var(--broken); background:var(--broken-bg); border-radius:5px; padding:6px 8px }}
</style></head><body>
<header>
  <h1>Pulse — recording script</h1>
  <p>Total <b>{total}</b> at {wpm} words a minute, which is <b>{over}</b> the {cap} cap.
  Generated from docs/pulse/video-narration.txt — edit that, not this.</p>
</header>
<main><table><tbody>{rows}</tbody></table></main>
</body></html>
"""

if __name__ == "__main__":
    OUT.write_text(build())
    print(OUT)
