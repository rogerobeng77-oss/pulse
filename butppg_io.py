"""Read BUT PPG records: WFDB headers, 16-bit signals, and QRS reference beats."""
from __future__ import annotations
import numpy as np
from pathlib import Path

def read_header(hea: Path) -> dict:
    lines = [l.strip() for l in hea.read_text().splitlines() if l.strip() and not l.startswith("#")]
    name, nsig, fs, nsamp = lines[0].split()[:4]
    sigs = []
    for l in lines[1:1 + int(nsig)]:
        f = l.split()
        gain = f[2].split("(")[0].split("/")[0]
        sigs.append({"file": f[0], "gain": float(gain) if gain else 1.0,
                     "baseline": int(f[2].split("(")[1].split(")")[0]) if "(" in f[2] else 0,
                     "name": f[-1]})
    return {"name": name, "nsig": int(nsig), "fs": float(fs), "nsamp": int(nsamp), "sigs": sigs}

def read_signal(hea: Path) -> tuple[np.ndarray, dict]:
    h = read_header(hea)
    # baselines run to hundreds of thousands; subtracting them in int16 overflows
    raw = np.fromfile(hea.with_suffix(".dat"), dtype="<i2").astype(np.float64)
    n = h["nsamp"]; k = h["nsig"]
    raw = raw[: n * k].reshape(n, k)
    out = np.empty((n, k), dtype=np.float64)
    for i, s in enumerate(h["sigs"]):
        out[:, i] = (raw[:, i] - s["baseline"]) / (s["gain"] or 1.0)
    return out, h

def read_qrs(path: Path) -> np.ndarray:
    """WFDB annotation file -> sample indices of reference beats."""
    b = np.fromfile(path, dtype=np.uint8).astype(np.int64)  # avoid uint8 overflow in the bit maths
    pos, i, t = [], 0, 0
    while i + 1 < len(b):
        word = b[i] | (b[i + 1] << 8)
        code, interval = word >> 10, word & 0x3FF
        i += 2
        if code == 59 and interval == 0:          # SKIP: 4-byte absolute interval
            if i + 3 >= len(b): break
            interval = (b[i + 1] << 24) | (b[i] << 16) | (b[i + 3] << 8) | b[i + 2]
            i += 4
            code = (b[i] | (b[i + 1] << 8)) >> 10 if i + 1 < len(b) else 0
            i += 2
        elif code in (60, 61, 62, 63):            # NUM/SUB/CHN/AUX payloads
            if code == 63:
                i += interval + (interval % 2)
            continue
        if code == 0 and interval == 0:
            break
        t += interval
        if 1 <= code <= 13:                        # beat annotations
            pos.append(t)
    return np.array(pos, dtype=int)
