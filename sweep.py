"""Choose the refusal threshold with the cost of each error visible.

Disagreeing with the annotators is not automatically wrong. What matters is
whether the rate we report on a trace they rejected is actually accurate. A
disagreement where we are right is caution we can spend; one where we are wrong
is a number a person might act on.
"""
from __future__ import annotations
import csv
from pathlib import Path
import numpy as np
import butppg_io as io, ppg

HERE = Path(__file__).resolve().parent
ROOT = next(HERE.glob("data/butppg/**/*_PPG.hea")).parent.parent

ann = {}
with (HERE / "data" / "quality-hr-ann.csv").open(encoding="utf-8-sig") as f:
    for r in csv.DictReader(f):
        try: ann[r["ID"].strip()] = (int(r["Quality"]), float(r["HR"]))
        except (ValueError, KeyError): pass

cache = []
for rec in sorted(p for p in ROOT.iterdir() if p.is_dir()):
    key = rec.name
    if key not in ann: continue
    hea = rec / f"{key}_PPG.hea"
    try:
        h0 = io.read_header(hea)
        if h0["nsig"] != 3 or h0["nsamp"] < 150: continue
        sig, h = io.read_signal(hea)
    except Exception: continue
    names = [s["name"] for s in h["sigs"]]
    ch = names.index("PPG_G") if "PPG_G" in names else 1
    raw = sig[:, ch]
    x = ppg.bandpass(ppg.detrend_normalise(raw), h["fs"])
    peaks = ppg.find_beats(x, h["fs"])
    if peaks.size < 3: continue
    ibi = ppg.intervals_ms(peaks, h["fs"])
    hr = 60000.0 / np.mean(ibi)
    purity, peak_bpm = ppg.spectral_purity(x, h["fs"])
    cache.append({"good": ann[key][0] == 1, "ref": ann[key][1], "hr": hr,
                  "purity": purity, "peak_bpm": peak_bpm})

print(f"traces with detectable beats: {len(cache)}\n")
print(f"{'purity':>7} {'accept':>7} {'of which they call good':>24} {'MAE on accepted':>16} {'within 10bpm':>13}")
for thr in (0.80, 0.85, 0.88, 0.90, 0.92, 0.94, 0.96):
    acc = [c for c in cache if c["purity"] >= thr
           and abs(c["hr"] - c["peak_bpm"]) / max(c["peak_bpm"], 1) <= 0.25]
    if not acc: continue
    err = np.array([abs(c["hr"] - c["ref"]) for c in acc])
    goodfrac = np.mean([c["good"] for c in acc])
    print(f"{thr:>7.2f} {len(acc):>7} {goodfrac*100:>23.0f}% {err.mean():>15.2f} {np.mean(err<=10)*100:>12.0f}%")
