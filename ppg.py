"""Pulse rhythm from a photoplethysmogram.

The whole method is arithmetic you can check by hand, on purpose. A model that
says "irregular" without showing why is useless to a clinician, and a student
project that cannot explain its own maths is worse.

Pipeline: detrend, bandpass to plausible heart rates, find beats, measure the
intervals between them, then judge the spread of those intervals.
"""

from __future__ import annotations

import numpy as np
from scipy.signal import butter, filtfilt, find_peaks

#: Adult heart rates live between about 30 and 200 bpm. Anything outside that
#: is noise, not a pulse, and letting it through is how a shaky hand becomes a
#: diagnosis.
HR_MIN_BPM, HR_MAX_BPM = 30.0, 200.0
#: Chosen on BUT PPG against heart rates derived from the simultaneous ECG's
#: R-peak annotations -- not against the dataset's own HR column, which is
#: doubled for one subject and differs from the R-peaks by 2.98 bpm on average.
#: Raising it refuses more, which is the safe direction: a wrong rate is worse
#: than no rate. At 0.85, with the cleanest-window selection below, the tool
#: accepts 5.3% of the corpus and 85.1% of those rates land within 5 bpm of the
#: ECG. (Measuring a fixed ten-second window instead gives 3.5% and 90%: fewer
#: recordings, each a little more accurate. See validation.json.)
PURITY_MIN = 0.85
#: Peak-counting and the spectrum are independent estimates of the same rate.
#: Requiring them to agree closely is the single most effective check here:
#: it is what catches the half-rate errors that come from missed alternate
#: beats, which are otherwise indistinguishable from a genuine bradycardia.
AGREEMENT_TOL = 0.05
LOW_HZ, HIGH_HZ = HR_MIN_BPM / 60.0, HR_MAX_BPM / 60.0


def bandpass(x: np.ndarray, fs: float) -> np.ndarray:
    ny = fs / 2.0
    lo, hi = LOW_HZ / ny, min(HIGH_HZ / ny, 0.99)
    b, a = butter(3, [lo, hi], btype="band")
    return filtfilt(b, a, x).astype(np.float64)


def detrend_normalise(x: np.ndarray) -> np.ndarray:
    x = np.asarray(x, dtype=np.float64)
    x = x - np.mean(x)
    s = np.std(x)
    return x / s if s > 0 else x


def find_beats(x: np.ndarray, fs: float) -> np.ndarray:
    """Beat sample indices.

    Minimum spacing comes from the maximum plausible rate, so one beat cannot
    be counted twice. Prominence is relative to the signal's own spread, so it
    adapts to a weak trace instead of needing a magic constant.
    """
    min_gap = int(fs * 60.0 / HR_MAX_BPM)
    prom = 0.3 * np.std(x)
    peaks, _ = find_peaks(x, distance=max(min_gap, 1), prominence=prom)
    return peaks


def intervals_ms(peaks: np.ndarray, fs: float) -> np.ndarray:
    if peaks.size < 2:
        return np.array([])
    return np.diff(peaks) / fs * 1000.0


def irregularity(ibi: np.ndarray) -> dict:
    """Standard beat-to-beat variability measures.

    rmssd and pnn50 are the usual descriptors of how much consecutive beats
    differ. Atrial fibrillation is irregularly irregular, so both run high;
    a steady rhythm keeps them low. These are descriptions of the trace, not
    a diagnosis of the heart.
    """
    if ibi.size < 3:
        return {"n_beats": int(ibi.size + 1) if ibi.size else 0}
    diffs = np.diff(ibi)
    rmssd = float(np.sqrt(np.mean(diffs ** 2)))
    pnn50 = float(np.mean(np.abs(diffs) > 50.0))
    mean_ibi = float(np.mean(ibi))
    return {
        "n_beats": int(ibi.size + 1),
        "mean_ibi_ms": mean_ibi,
        "hr_bpm": 60000.0 / mean_ibi if mean_ibi > 0 else 0.0,
        "sdnn_ms": float(np.std(ibi)),
        "rmssd_ms": rmssd,
        "pnn50": pnn50,
        "cv": float(np.std(ibi) / mean_ibi) if mean_ibi > 0 else 0.0,
    }


def spectral_purity(x: np.ndarray, fs: float) -> tuple[float, float]:
    """How much of the in-band power sits in one peak, and where that peak is.

    A real pulse is close to periodic, so its spectrum has one dominant lobe in
    the heart-rate band. A trace dominated by movement smears across the band.
    This turns out to separate measurable from unmeasurable far better than
    anything measured in the time domain.
    """
    n = x.size
    win = np.hanning(n)
    spec = np.abs(np.fft.rfft(x * win)) ** 2
    freqs = np.fft.rfftfreq(n, 1.0 / fs)
    band = (freqs >= LOW_HZ) & (freqs <= HIGH_HZ)
    if not band.any() or spec[band].sum() <= 0:
        return 0.0, 0.0
    bp = spec[band]
    bf = freqs[band]
    k = int(np.argmax(bp))
    # the peak plus its immediate neighbours, against all in-band power
    lo, hi = max(k - 1, 0), min(k + 2, bp.size)
    return float(bp[lo:hi].sum() / bp.sum()), float(bf[k] * 60.0)


def signal_quality(x: np.ndarray, peaks: np.ndarray, fs: float) -> dict:
    """Can this trace be measured at all?

    Most smartphone PPG recordings cannot. In BUT PPG, 3,058 of 3,888 records
    are annotated poor quality. Refusing is the common correct answer, so the
    tool has to be good at it rather than treat it as an edge case.
    """
    # Four peaks, not three: three peaks give two intervals, and the spread of
    # two numbers says nothing about rhythm. A trace that cannot support the
    # measurement should not pass the gate that guards it.
    if peaks.size < 4:
        return {"usable": False, "reason": "too few beats detected", "beats": int(peaks.size)}
    ibi = intervals_ms(peaks, fs)
    hr = 60000.0 / np.mean(ibi)
    if not (HR_MIN_BPM <= hr <= HR_MAX_BPM):
        return {"usable": False, "reason": f"implied rate {hr:.0f} bpm is outside 30-200", "beats": int(peaks.size)}
    # A trace whose beats vary wildly in height is usually a moving finger
    purity, peak_bpm = spectral_purity(x, fs)
    if purity < PURITY_MIN:
        return {"usable": False, "beats": int(peaks.size), "purity": purity,
                "reason": "no single dominant pulse frequency; likely movement or poor contact"}
    # the beats we counted should agree with the frequency the spectrum found
    if peak_bpm > 0 and abs(hr - peak_bpm) / peak_bpm > AGREEMENT_TOL:
        return {"usable": False, "beats": int(peaks.size), "purity": purity,
                "reason": f"counted {hr:.0f} bpm but the spectrum says {peak_bpm:.0f} bpm"}
    return {"usable": True, "reason": "", "beats": int(peaks.size), "purity": purity}


#: filtfilt needs a few times the filter order in samples. A trace shorter than
#: this cannot be filtered, let alone measured, so it is refused rather than
#: forced through -- the same answer the tool gives a human holding still badly.
MIN_SECONDS = 4.0
#: Accuracy is duration-limited rather than method-limited: on the same gate,
#: the share of rates within 5 bpm of the ECG runs 61% at a 4 s window, 74% at
#: 6 s, 82% at 8 s and 90% at 10 s. Longer is better, but a longer clip also
#: has more opportunity to contain movement, so the tool records generously and
#: measures the calmest stretch it can find rather than whatever it began with.
WINDOW_SECONDS = 8.0
WINDOW_STEP_SECONDS = 0.5


def analyse(raw: np.ndarray, fs: float) -> dict:
    raw = np.asarray(raw, dtype=np.float64).ravel()
    if raw.size < max(int(MIN_SECONDS * fs), 25):
        return {"fs": fs, "peaks": [], "quality": {
            "usable": False,
            "reason": f"recording is {raw.size / fs:.1f} s; needs at least {MIN_SECONDS:.0f} s",
            "beats": 0}}
    n = int(WINDOW_SECONDS * fs)
    if raw.size <= n:
        offsets = [0]
        n = raw.size
    else:
        step = max(int(WINDOW_STEP_SECONDS * fs), 1)
        offsets = list(range(0, raw.size - n + 1, step))

    # Every candidate window is scored; the calmest one is the one we report.
    # Picking by purity rather than by the rate it produces keeps the choice
    # independent of the answer, so this cannot quietly select for a number.
    best = None
    for off in offsets:
        x = bandpass(detrend_normalise(raw[off:off + n]), fs)
        peaks = find_beats(x, fs)
        q = signal_quality(x, peaks, fs)
        score = q.get("purity", -1.0)
        if best is None or score > best[0]:
            best = (score, off, x, peaks, q)

    _, off, x, peaks, q = best
    out = {"fs": fs, "quality": q, "peaks": peaks.tolist(),
           "window": {"start_s": off / fs, "seconds": n / fs,
                      "of_seconds": raw.size / fs}}
    if q["usable"]:
        out.update(irregularity(intervals_ms(peaks, fs)))
    return out
