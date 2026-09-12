"""Reference fixtures for web/dsp.js, computed by the Python that defines truth.

Real BUT PPG green-channel traces are given browser-shaped timestamps -- 30 Hz
nominal with per-frame jitter, the way a phone camera actually delivers frames
-- then resampled onto a uniform 30 Hz grid and pushed through ppg.py. Both
languages resample with the identical arithmetic so the comparison downstream
is of the DSP, not of two different interpolators.

Writes dsp_fixtures.json for verify_dsp.mjs.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np

import butppg_io as io
import ppg

HERE = Path(__file__).resolve().parent
ROOT = next(HERE.glob("data/butppg/**/*_PPG.hea")).parent.parent
FS = 30.0
N_TRACES = 200


def jittered_timestamps(n: int, seed: int) -> list[float]:
    """Per-frame capture times a phone would plausibly produce.

    A plain 33.333 ms cadence would make the resampler an identity and hide any
    bug in it, so frames arrive early or late by up to 30% of a period. A tiny
    LCG rather than numpy's generator, so the sequence is trivially auditable.
    """
    state = (seed * 6364136223846793005 + 1442695040888963407) & ((1 << 64) - 1)
    ts, t = [], 0.0
    for _ in range(n):
        ts.append(t)
        state = (state * 6364136223846793005 + 1442695040888963407) & ((1 << 64) - 1)
        u = ((state >> 11) & ((1 << 53) - 1)) / float(1 << 53)
        t += (1000.0 / FS) * (0.7 + 0.6 * u)
    return ts


def resample_to_30hz(values: list[float], ts: list[float]) -> np.ndarray:
    """The same linear resample web/dsp.js performs, operation for operation.

    Deliberately not np.interp: np.interp evaluates slope*(x-x0)+y0 with a
    precomputed slope, which rounds differently from the y0 + w*(y1-y0) form
    used in the browser. Matching the form here keeps the two grids bit-equal
    so any later divergence is attributable to the DSP.
    """
    n = min(len(values), len(ts))
    if n == 0:
        return np.zeros(0)
    if n == 1:
        return np.array([values[0]], dtype=np.float64)
    t0 = ts[0]
    dt = 1000.0 / FS
    count = int(np.floor((ts[n - 1] - t0) / dt)) + 1
    out = np.empty(count, dtype=np.float64)
    j = 0
    for i in range(count):
        t = t0 + i * dt
        while j + 2 < n and ts[j + 1] < t:
            j += 1
        ta, tb = ts[j], ts[j + 1]
        if t <= ta:
            out[i] = values[j]
        elif t >= tb:
            out[i] = values[j + 1]
        else:
            w = (t - ta) / (tb - ta)
            out[i] = values[j] + w * (values[j + 1] - values[j])
    return out


def sweep(raw: np.ndarray) -> tuple[int, int, np.ndarray, list[dict]]:
    """Re-run analyse's selection loop, keeping every candidate window.

    analyse reports one window and discards the rest, but the rest are where a
    port is most likely to go wrong: the choice is an argmax over purities that
    sit within a percent of each other, so a single wrong window is the visible
    symptom of an invisible arithmetic difference. Checking all of them turns
    one comparison per trace into five.
    """
    n = int(ppg.WINDOW_SECONDS * FS)
    if raw.size <= n:
        offsets, n = [0], raw.size
    else:
        step = max(int(ppg.WINDOW_STEP_SECONDS * FS), 1)
        offsets = list(range(0, raw.size - n + 1, step))
    best, rows = None, []
    for off in offsets:
        x = ppg.bandpass(ppg.detrend_normalise(raw[off:off + n]), FS)
        peaks = ppg.find_beats(x, FS)
        q = ppg.signal_quality(x, peaks, FS)
        purity, peak_bpm = ppg.spectral_purity(x, FS)
        score = q.get("purity", -1.0)
        rows.append({"off": off, "peaks": [int(p) for p in peaks],
                     "purity": float(purity), "peak_bpm": float(peak_bpm),
                     "score": float(score), "usable": bool(q["usable"]),
                     "reason": q["reason"] if "reason" in q else ""})
        if best is None or score > best[0]:
            best = (score, off, x)
    return best[1], n, best[2], rows


def peak_height_ties(x: np.ndarray) -> int:
    """Local maxima sharing an exactly equal height within one exclusion zone.

    scipy resolves those with an unstable argsort, so they are the one place
    the beat indices could legitimately disagree between implementations.
    Counting them turns "probably fine" into a number.
    """
    from scipy.signal import find_peaks
    cand, _ = find_peaks(x)
    if cand.size < 2:
        return 0
    gap = max(int(FS * 60.0 / ppg.HR_MAX_BPM), 1)
    h = x[cand]
    ties = 0
    for i in range(cand.size):
        for j in range(i + 1, cand.size):
            if cand[j] - cand[i] >= gap:
                break
            if h[i] == h[j]:
                ties += 1
    return ties


def opt(v) -> float | None:
    return None if v is None else float(v)


def green_channel(rec: Path) -> np.ndarray | None:
    """The green trace, or None if this record is not the camera modality."""
    hea = rec / f"{rec.name}_PPG.hea"
    if not hea.exists():
        return None
    try:
        h0 = io.read_header(hea)
        # 48 legacy records encode 300 samples as 300 one-sample signals.
        if h0["nsig"] != 3 or h0["nsamp"] < 150:
            return None
        sig, h = io.read_signal(hea)
    except Exception:
        return None
    names = [s["name"] for s in h["sigs"]]
    ch = names.index("PPG_G") if "PPG_G" in names else 0
    return (sig[:, ch] if sig.ndim > 1 else sig.ravel()).astype(np.float64)


def select_records() -> list[Path]:
    """A sequential slice plus every measurable record in the corpus.

    The sequential slice is the honest sample: whatever the dataset happens to
    hand over, overwhelmingly traces the tool refuses. But the refusal path
    exits early and never reaches the rate or the variability maths, so the
    measurable records -- 3.5% of the corpus -- are added on top to give the
    comparison something to compare on the other side of the gate.
    """
    recs = sorted(p for p in ROOT.iterdir() if p.is_dir())
    chosen = recs[:N_TRACES]
    seen = {p.name for p in chosen}
    cache = HERE / "dsp_usable_ids.json"
    if cache.exists():
        ids = json.loads(cache.read_text())
    else:
        ids = []
        for rec in recs:
            values = green_channel(rec)
            if values is None:
                continue
            grid = resample_to_30hz(values.tolist(), jittered_timestamps(values.size, int(rec.name)))
            if ppg.analyse(grid, FS)["quality"]["usable"]:
                ids.append(rec.name)
        cache.write_text(json.dumps(ids))
    by_name = {p.name: p for p in recs}
    chosen += [by_name[i] for i in ids if i not in seen]
    return chosen


def fixture(rec_id: str, values: np.ndarray, ts: list[float]) -> dict:
        grid = resample_to_30hz(values.tolist(), ts)
        res = ppg.analyse(grid, FS)
        # Below the minimum duration analyse refuses before filtering anything,
        # so there is no window and no filtered trace to compare -- only the
        # refusal itself, which is still worth checking word for word.
        short = grid.size < max(int(ppg.MIN_SECONDS * FS), 25)
        full = [] if short else ppg.bandpass(ppg.detrend_normalise(grid), FS).tolist()
        if short:
            off, wlen, xwin, rows = 0, 0, np.zeros(0), []
        else:
            off, wlen, xwin, rows = sweep(grid)

        return {
            "id": rec_id,
            "values": values.tolist(),
            "timestamps_ms": ts,
            "grid": grid.tolist(),
            "too_short": short,
            "filtered_full": full,
            "filtered_window": xwin.tolist(),
            "windows": rows,
            "window_offset": off,
            "window_len": wlen,
            "peaks": [int(p) for p in res["peaks"]],
            "usable": bool(res["quality"]["usable"]),
            "reason": res["quality"].get("reason", ""),
            # None, not NaN: the JSON has to survive a strict parser on the
            # other side, and "this quantity was never computed" is exactly
            # what the early-exit branches mean.
            "purity": opt(res["quality"].get("purity")),
            "hr_bpm": opt(res.get("hr_bpm")),
            "rmssd_ms": opt(res.get("rmssd_ms")),
            "sdnn_ms": opt(res.get("sdnn_ms")),
            "pnn50": opt(res.get("pnn50")),
            "cv": opt(res.get("cv")),
            "n_beats": int(res.get("n_beats", 0)),
            "window_start_s": float(res["window"]["start_s"]) if "window" in res else None,
            "window_seconds": float(res["window"]["seconds"]) if "window" in res else None,
            "height_ties": peak_height_ties(xwin) if xwin.size else 0,
        }


def find_beats_stable(x: np.ndarray) -> list[int]:
    """find_beats with the one arbitrary choice in scipy made deterministic.

    scipy resolves equal peak heights with np.argsort's default quicksort,
    which is unstable -- and on numpy 2 it may dispatch to an AVX-512 kernel,
    so the order is not even fixed across machines running the same code. The
    port cannot chase that, so it sorts stably instead. This recomputes the
    Python answer under the same stable rule: where the two agree, the port is
    exact, and the difference from plain find_beats is the whole cost of the
    choice, measured rather than asserted.
    """
    from scipy.signal import find_peaks
    from scipy.signal import _peak_finding_utils as pfu
    cand, _ = find_peaks(x)
    if cand.size == 0:
        return []
    gap = max(int(FS * 60.0 / ppg.HR_MAX_BPM), 1)
    keep = np.ones(cand.size, dtype=np.uint8)
    order = np.argsort(x[cand], kind="stable")
    for i in range(cand.size - 1, -1, -1):
        j = order[i]
        if keep[j] == 0:
            continue
        k = j - 1
        while k >= 0 and cand[j] - cand[k] < gap:
            keep[k] = 0
            k -= 1
        k = j + 1
        while k < cand.size and cand[k] - cand[j] < gap:
            keep[k] = 0
            k += 1
    pk = cand[keep.view(bool)]
    proms = pfu._peak_prominences(x, pk.astype(np.intp), -1)[0]
    return [int(v) for v in pk[proms >= 0.3 * np.std(x)]]


def adversarial() -> list[dict]:
    """Signals engineered to hit the branches real PPG never reaches.

    A filtered photoplethysmogram is a smooth float64 trace: no two local
    maxima in it are ever exactly equal, and no maximum is ever a plateau. Both
    cases exist in scipy's peak finder, both are ported here, and neither would
    be exercised by a single BUT PPG record. Quantised and repeated-value
    signals force them. The distance rule in particular resolves exact ties
    through an unstable argsort, so this is where the port is allowed to
    disagree -- and where that has to be measured rather than assumed.
    """
    rng = np.random.default_rng(20260912)
    cases: list[tuple[str, np.ndarray]] = [
        ("constant", np.full(200, 3.5)),
        ("zeros", np.zeros(200)),
        ("ramp", np.arange(200, dtype=np.float64)),
        ("alternating", np.tile([0.0, 1.0], 100)),
        ("plateaus", np.repeat(np.array([0.0, 1.0, 0.0, 2.0, 2.0, 0.0, 1.0, 1.0, 1.0]), 12)[:200]),
        ("staircase", np.concatenate([np.full(w, float(v)) for w, v in
                                      zip([1, 2, 3, 4, 5] * 8, rng.integers(0, 4, 40))])),
        ("quantised sine", np.round(np.sin(np.arange(240) * 0.35) * 3.0) / 3.0),
        ("coarse sine", np.round(np.sin(np.arange(240) * 0.21) * 2.0)),
        ("small ints", rng.integers(0, 4, 240).astype(np.float64)),
        ("two levels", rng.integers(0, 2, 240).astype(np.float64)),
        ("sine + ties", np.round(np.sin(np.arange(300) * 0.2) * 10.0) / 10.0),
        ("single spike", np.concatenate([np.zeros(100), [1.0], np.zeros(99)])),
        ("smooth sine", np.sin(np.arange(300) * 0.2)),
        ("noisy sine", np.sin(np.arange(300) * 0.2) + rng.normal(0, 0.1, 300)),
    ]
    out = []
    for name, x in cases:
        x = x.astype(np.float64)
        peaks = ppg.find_beats(x, FS)
        ibi = ppg.intervals_ms(peaks, FS)
        purity, peak_bpm = ppg.spectral_purity(x, FS)
        out.append({
            "name": name,
            "x": x.tolist(),
            "detrended": ppg.detrend_normalise(x).tolist(),
            "filtfilt": ppg.bandpass(x, FS).tolist(),
            "peaks": [int(p) for p in peaks],
            "peaks_stable": find_beats_stable(x),
            "ibi": ibi.tolist(),
            "irregularity": {k: (float(v) if not isinstance(v, int) else v)
                             for k, v in ppg.irregularity(ibi).items()},
            "purity": float(purity),
            "peak_bpm": float(peak_bpm),
            "quality": {k: (float(v) if isinstance(v, float) else v)
                        for k, v in ppg.signal_quality(x, peaks, FS).items()},
            "height_ties": peak_height_ties(x),
        })
    return out


def main() -> None:
    out = []
    for rec in select_records():
        values = green_channel(rec)
        if values is None:
            continue
        # The seed is the record name, so a trace keeps its jitter regardless of
        # where it lands in the list.
        ts = jittered_timestamps(values.size, int(rec.name))
        out.append(fixture(rec.name, values, ts))
        # BUT PPG is uniformly 10 s, which never exercises the two branches a
        # phone will hit first: a clip shorter than one window, and a clip too
        # short to measure at all. Truncated copies of the first few traces
        # cover both.
        if len(out) <= 120:
            out.append(fixture(rec.name + "@5s", values[:150], ts[:150]))
            out.append(fixture(rec.name + "@3s", values[:90], ts[:90]))

    (HERE / "dsp_fixtures.json").write_text(json.dumps(out))
    adv = adversarial()
    (HERE / "dsp_unit_fixtures.json").write_text(json.dumps(adv))
    usable = sum(r["usable"] for r in out)
    ties = sum(r["height_ties"] for r in out)
    print(f"traces: {len(out)}   usable: {usable}   exact peak-height ties: {ties}")
    print(f"adversarial signals: {len(adv)}   exact peak-height ties in them: "
          f"{sum(a['height_ties'] for a in adv)}")


if __name__ == "__main__":
    main()
