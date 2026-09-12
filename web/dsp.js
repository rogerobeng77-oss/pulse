/**
 * Pulse rhythm from a photoplethysmogram, in the browser.
 *
 * A line-for-line port of ppg.py. The Python is the source of truth; this file
 * exists so the phone can do the arithmetic without shipping the frames
 * anywhere. verify_dsp.mjs checks the two against each other on real BUT PPG
 * traces, because a port that quietly drifts is worse than no port.
 *
 * Everything here runs at a fixed 30 Hz. Camera frame rates wander -- 28 Hz on
 * a cold phone, 31 on a warm one, and neither is uniform -- so the caller
 * resamples onto a 30 Hz grid first and the filter never has to be redesigned.
 */

export const HR_MIN_BPM = 30.0;
export const HR_MAX_BPM = 200.0;
export const PURITY_MIN = 0.85;
export const AGREEMENT_TOL = 0.05;
export const LOW_HZ = HR_MIN_BPM / 60.0;
export const HIGH_HZ = HR_MAX_BPM / 60.0;
export const MIN_SECONDS = 4.0;
export const WINDOW_SECONDS = 8.0;
export const WINDOW_STEP_SECONDS = 0.5;

/** The one sample rate this module is designed for. */
export const FS = 30.0;

// scipy.signal.butter(3, [0.5/15, 3.3333333333333335/15], btype="band") at
// fs = 30. Designing a Butterworth in JS would mean porting bilinear
// transforms and complex pole placement for a filter that never changes, so
// the coefficients are lifted verbatim -- shortest round-trip decimal, which
// is exact for float64.
export const B = [
  0.015641668161113648, 0.0, -0.04692500448334094, 0.0,
  0.04692500448334094, 0.0, -0.015641668161113648,
];
export const A = [
  1.0, -4.646768904846301, 9.153515799958402, -9.833575204677665,
  6.0972389352023795, -2.0695294630527683, 0.2993485646941389,
];
// scipy.signal.lfilter_zi(B, A): the delay state that holds a constant input
// at a constant output. filtfilt scales it by the first sample of each pass so
// the filter starts already settled instead of ringing for the first second.
export const ZI = [
  -0.015641668161113648, -0.015641668161113648, 0.031283336322227295,
  0.031283336322227295, -0.015641668161113648, -0.015641668161113648,
];
// filtfilt's default: 3 * max(len(a), len(b)).
const PADLEN = 3 * Math.max(A.length, B.length);

/**
 * numpy's pairwise summation, reproduced.
 *
 * np.mean and np.std do not add left to right; they use eight accumulators
 * under 128 elements and recurse above it. Summing naively here puts the two
 * languages ~1e-16 apart, which is harmless for a heart rate but can tip a
 * near-tied peak and change the beat indices. Cheap insurance.
 */
function pairwiseSum(a, off, n) {
  if (n < 8) {
    let res = 0.0;
    for (let i = 0; i < n; i++) res += a[off + i];
    return res;
  }
  if (n <= 128) {
    const r = [a[off], a[off + 1], a[off + 2], a[off + 3],
               a[off + 4], a[off + 5], a[off + 6], a[off + 7]];
    let i = 8;
    for (; i < n - (n % 8); i += 8) {
      r[0] += a[off + i];     r[1] += a[off + i + 1];
      r[2] += a[off + i + 2]; r[3] += a[off + i + 3];
      r[4] += a[off + i + 4]; r[5] += a[off + i + 5];
      r[6] += a[off + i + 6]; r[7] += a[off + i + 7];
    }
    let res = ((r[0] + r[1]) + (r[2] + r[3])) + ((r[4] + r[5]) + (r[6] + r[7]));
    for (; i < n; i++) res += a[off + i];
    return res;
  }
  let n2 = (n / 2) | 0;
  n2 -= n2 % 8;
  return pairwiseSum(a, off, n2) + pairwiseSum(a, off + n2, n - n2);
}

function mean(x) {
  return pairwiseSum(x, 0, x.length) / x.length;
}

/** Population standard deviation, ddof=0, as np.std computes it. */
function std(x) {
  const m = pairwiseSum(x, 0, x.length) / x.length;
  const sq = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) {
    const d = x[i] - m;
    sq[i] = d * d;
  }
  return Math.sqrt(pairwiseSum(sq, 0, sq.length) / sq.length);
}

/**
 * Linear resample of camera samples onto a uniform 30 Hz grid.
 *
 * The grid starts at the first frame's timestamp and runs to the last one that
 * still falls inside the recording, so no sample is invented past the end.
 * Values outside the input range clamp to the endpoints, matching np.interp.
 */
export function resampleTo30Hz(values, timestampsMs) {
  const n = Math.min(values.length, timestampsMs.length);
  if (n === 0) return new Float64Array(0);
  if (n === 1) return Float64Array.of(values[0]);
  const t0 = timestampsMs[0];
  const span = timestampsMs[n - 1] - t0;
  const dt = 1000.0 / FS;
  const count = Math.floor(span / dt) + 1;
  const out = new Float64Array(count);
  let j = 0;
  for (let i = 0; i < count; i++) {
    const t = t0 + i * dt;
    while (j + 2 < n && timestampsMs[j + 1] < t) j++;
    const ta = timestampsMs[j];
    const tb = timestampsMs[j + 1];
    if (t <= ta) { out[i] = values[j]; continue; }
    if (t >= tb) { out[i] = values[j + 1]; continue; }
    const w = (t - ta) / (tb - ta);
    out[i] = values[j] + w * (values[j + 1] - values[j]);
  }
  return out;
}

/**
 * scipy.signal.lfilter for a fixed-length IIR with a given initial state.
 *
 * Transposed direct form II, with the same operation grouping scipy's C loop
 * uses so the rounding lands identically.
 */
function lfilter(x, zi) {
  const n = x.length;
  const N = A.length;
  const y = new Float64Array(n);
  const z = zi.slice();
  for (let k = 0; k < n; k++) {
    const xk = x[k];
    const yk = B[0] * xk + z[0];
    y[k] = yk;
    for (let i = 0; i < N - 2; i++) {
      z[i] = B[i + 1] * xk + z[i + 1] - A[i + 1] * yk;
    }
    z[N - 2] = B[N - 1] * xk - A[N - 1] * yk;
  }
  return y;
}

/**
 * scipy.signal.filtfilt with its defaults: odd padding, padlen 3*ntaps, and
 * the lfilter_zi trick on both passes.
 *
 * The odd extension reflects the signal through its own endpoint -- 2*x[0]
 * minus the mirrored run -- so the filter sees a continuous slope instead of a
 * step at the edges. Dropping any of these three pieces still produces a
 * plausible-looking filtered trace, which is exactly why it has to be checked.
 */
export function filtfilt(x) {
  const n = x.length;
  if (n <= PADLEN) {
    throw new Error(`the length of the input vector must be greater than ${PADLEN}`);
  }
  const ext = new Float64Array(n + 2 * PADLEN);
  const first = x[0];
  const last = x[n - 1];
  for (let i = 0; i < PADLEN; i++) ext[i] = 2 * first - x[PADLEN - i];
  ext.set(x, PADLEN);
  for (let i = 0; i < PADLEN; i++) ext[n + PADLEN + i] = 2 * last - x[n - 2 - i];

  const ziF = ZI.map((v) => v * ext[0]);
  const fwd = lfilter(ext, ziF);

  const rev = new Float64Array(fwd.length);
  for (let i = 0; i < fwd.length; i++) rev[i] = fwd[fwd.length - 1 - i];
  const ziB = ZI.map((v) => v * rev[0]);
  const back = lfilter(rev, ziB);

  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = back[back.length - 1 - PADLEN - i];
  return out;
}

export function bandpass(x, fs = FS) {
  if (fs !== FS) throw new Error(`coefficients are fixed at ${FS} Hz, got ${fs}`);
  return filtfilt(x);
}

export function detrendNormalise(x) {
  const out = new Float64Array(x.length);
  const m = mean(x);
  for (let i = 0; i < x.length; i++) out[i] = x[i] - m;
  const s = std(out);
  if (s > 0) for (let i = 0; i < out.length; i++) out[i] /= s;
  return out;
}

/** scipy's _local_maxima_1d: midpoints of flat plateaus, not just strict peaks. */
function localMaxima1d(x) {
  const peaks = [];
  const iMax = x.length - 1;
  let i = 1;
  while (i < iMax) {
    if (x[i - 1] < x[i]) {
      let ahead = i + 1;
      while (ahead < iMax && x[ahead] === x[i]) ahead++;
      if (x[ahead] < x[i]) {
        peaks.push((i + (ahead - 1)) >> 1);
        i = ahead;
      }
    }
    i++;
  }
  return peaks;
}

/**
 * scipy's _select_by_peak_distance: keep the tallest, then suppress everything
 * within `distance` of it, working down the heights.
 *
 * scipy sorts with np.argsort's default quicksort, so peaks of exactly equal
 * height inside one another's exclusion zone are resolved arbitrarily -- and
 * on numpy 2 that call can dispatch to an AVX-512 kernel, so scipy's own order
 * is not fixed across machines. There is nothing stable to copy, so this sorts
 * stably and the harness proves the difference is confined to that: on
 * quantised signals the JS reproduces scipy-with-a-stable-sort beat for beat,
 * and on 1,570 windows of real filtered PPG no such tie occurs at all.
 */
function selectByPeakDistance(peaks, priority, distance) {
  const size = peaks.length;
  const d = Math.ceil(distance);
  const keep = new Uint8Array(size).fill(1);
  const order = Array.from({ length: size }, (_, i) => i);
  order.sort((p, q) => priority[p] - priority[q]);
  for (let i = size - 1; i >= 0; i--) {
    const j = order[i];
    if (keep[j] === 0) continue;
    let k = j - 1;
    while (k >= 0 && peaks[j] - peaks[k] < d) { keep[k] = 0; k--; }
    k = j + 1;
    while (k < size && peaks[k] - peaks[j] < d) { keep[k] = 0; k++; }
  }
  return keep;
}

/**
 * scipy's _peak_prominences with wlen unset: walk outwards from each peak
 * until the signal rises above it, and take the higher of the two valleys.
 */
function peakProminences(x, peaks) {
  const out = new Float64Array(peaks.length);
  const iMax = x.length - 1;
  for (let p = 0; p < peaks.length; p++) {
    const peak = peaks[p];
    let leftMin = x[peak];
    let i = peak;
    while (i >= 0 && x[i] <= x[peak]) {
      if (x[i] < leftMin) leftMin = x[i];
      i--;
    }
    let rightMin = x[peak];
    i = peak;
    while (i <= iMax && x[i] <= x[peak]) {
      if (x[i] < rightMin) rightMin = x[i];
      i++;
    }
    out[p] = x[peak] - Math.max(leftMin, rightMin);
  }
  return out;
}

/**
 * Beat sample indices.
 *
 * Minimum spacing comes from the maximum plausible rate, so one beat cannot
 * be counted twice. Prominence is relative to the signal's own spread, so it
 * adapts to a weak trace instead of needing a magic constant.
 *
 * scipy applies the distance rule before the prominence rule, and the two are
 * not commutative: a tall peak can suppress a neighbour and then be discarded
 * itself, leaving a gap. Swapping them is a silent behaviour change.
 */
export function findBeats(x, fs = FS) {
  const minGap = Math.trunc(fs * 60.0 / HR_MAX_BPM);
  const prom = 0.3 * std(x);
  let peaks = localMaxima1d(x);
  const keepD = selectByPeakDistance(peaks, peaks.map((i) => x[i]), Math.max(minGap, 1));
  peaks = peaks.filter((_, i) => keepD[i] === 1);
  const proms = peakProminences(x, peaks);
  return peaks.filter((_, i) => prom <= proms[i]);
}

export function intervalsMs(peaks, fs = FS) {
  if (peaks.length < 2) return new Float64Array(0);
  const out = new Float64Array(peaks.length - 1);
  for (let i = 0; i < out.length; i++) out[i] = (peaks[i + 1] - peaks[i]) / fs * 1000.0;
  return out;
}

/**
 * Standard beat-to-beat variability measures.
 *
 * rmssd and pnn50 are the usual descriptors of how much consecutive beats
 * differ. Atrial fibrillation is irregularly irregular, so both run high;
 * a steady rhythm keeps them low. These are descriptions of the trace, not
 * a diagnosis of the heart.
 */
export function irregularity(ibi) {
  if (ibi.length < 3) {
    return { n_beats: ibi.length ? ibi.length + 1 : 0 };
  }
  const diffs = new Float64Array(ibi.length - 1);
  for (let i = 0; i < diffs.length; i++) diffs[i] = ibi[i + 1] - ibi[i];
  const sq = new Float64Array(diffs.length);
  for (let i = 0; i < diffs.length; i++) sq[i] = diffs[i] * diffs[i];
  const rmssd = Math.sqrt(mean(sq));
  const over = new Float64Array(diffs.length);
  for (let i = 0; i < diffs.length; i++) over[i] = Math.abs(diffs[i]) > 50.0 ? 1 : 0;
  const meanIbi = mean(ibi);
  const sd = std(ibi);
  return {
    n_beats: ibi.length + 1,
    mean_ibi_ms: meanIbi,
    hr_bpm: meanIbi > 0 ? 60000.0 / meanIbi : 0.0,
    sdnn_ms: sd,
    rmssd_ms: rmssd,
    pnn50: mean(over),
    cv: meanIbi > 0 ? sd / meanIbi : 0.0,
  };
}

// np.hanning(n) and the rfft twiddles depend only on the window length, which
// is constant across every candidate window of a recording.
const fftCache = new Map();

function fftTables(n) {
  let t = fftCache.get(n);
  if (t) return t;
  const win = new Float64Array(n);
  if (n === 1) {
    win[0] = 1.0;
  } else {
    for (let i = 0; i < n; i++) win[i] = 0.5 + 0.5 * Math.cos(Math.PI * (1 - n + 2 * i) / (n - 1));
  }
  const half = (n >> 1) + 1;
  // np.fft.rfftfreq(n, 1/fs) to the bit: it forms 1/(n*d) once and multiplies,
  // which is not the same float as k*fs/n. The band edges are compared against
  // these, so a one-ulp difference could include or drop a bin.
  const val = 1.0 / (n * (1.0 / FS));
  const freqs = new Float64Array(half);
  for (let k = 0; k < half; k++) freqs[k] = k * val;
  // One period of cos/sin at the fundamental; every bin's twiddle is a stride
  // through it, which keeps the angles exact multiples of 2*pi/n.
  const cos = new Float64Array(n);
  const sin = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const ang = -2.0 * Math.PI * i / n;
    cos[i] = Math.cos(ang);
    sin[i] = Math.sin(ang);
  }
  t = { win, half, freqs, cos, sin };
  fftCache.set(n, t);
  return t;
}

/**
 * How much of the in-band power sits in one peak, and where that peak is.
 *
 * A real pulse is close to periodic, so its spectrum has one dominant lobe in
 * the heart-rate band. A trace dominated by movement smears across the band.
 * This turns out to separate measurable from unmeasurable far better than
 * anything measured in the time domain.
 *
 * A direct O(n^2) transform rather than an FFT: n is at most 240 here, the
 * whole sweep costs under a millisecond, and there is no radix bookkeeping to
 * get wrong.
 */
export function spectralPurity(x, fs = FS) {
  const n = x.length;
  const { win, half, freqs, cos, sin } = fftTables(n);
  const xw = new Float64Array(n);
  for (let i = 0; i < n; i++) xw[i] = x[i] * win[i];

  // The in-band bins are contiguous, and they are the only ones ever read, so
  // only those get transformed.
  let kLo = -1;
  let kHi = -2;
  for (let k = 0; k < half; k++) {
    if (freqs[k] >= LOW_HZ && freqs[k] <= HIGH_HZ) {
      if (kLo < 0) kLo = k;
      kHi = k;
    }
  }
  if (kLo < 0) return [0.0, 0.0];

  const bp = new Float64Array(kHi - kLo + 1);
  for (let k = kLo; k <= kHi; k++) {
    let re = 0.0;
    let im = 0.0;
    for (let i = 0; i < n; i++) {
      const idx = (i * k) % n;
      re += xw[i] * cos[idx];
      im += xw[i] * sin[idx];
    }
    const mag = Math.hypot(re, im);
    bp[k - kLo] = mag * mag;
  }

  const total = pairwiseSum(bp, 0, bp.length);
  if (!(total > 0)) return [0.0, 0.0];

  let kMax = 0;
  for (let i = 1; i < bp.length; i++) if (bp[i] > bp[kMax]) kMax = i;
  const lo = Math.max(kMax - 1, 0);
  const hi = Math.min(kMax + 2, bp.length);
  return [pairwiseSum(bp, lo, hi - lo) / total, freqs[kLo + kMax] * 60.0];
}

/**
 * Can this trace be measured at all?
 *
 * Most smartphone PPG recordings cannot. In BUT PPG, 3,058 of 3,888 records
 * are annotated poor quality. Refusing is the common correct answer, so the
 * tool has to be good at it rather than treat it as an edge case.
 */
export function signalQuality(x, peaks, fs = FS) {
  // Four peaks, not three: three peaks give two intervals, and the spread of
  // two numbers says nothing about rhythm. A trace that cannot support the
  // measurement should not pass the gate that guards it.
  if (peaks.length < 4) {
    return { usable: false, reason: "too few beats detected", beats: peaks.length };
  }
  const ibi = intervalsMs(peaks, fs);
  const hr = 60000.0 / mean(ibi);
  if (!(HR_MIN_BPM <= hr && hr <= HR_MAX_BPM)) {
    return { usable: false, reason: `implied rate ${fmt0(hr)} bpm is outside 30-200`, beats: peaks.length };
  }
  const [purity, peakBpm] = spectralPurity(x, fs);
  if (purity < PURITY_MIN) {
    return { usable: false, beats: peaks.length, purity,
             reason: "no single dominant pulse frequency; likely movement or poor contact" };
  }
  if (peakBpm > 0 && Math.abs(hr - peakBpm) / peakBpm > AGREEMENT_TOL) {
    return { usable: false, beats: peaks.length, purity,
             reason: `counted ${fmt0(hr)} bpm but the spectrum says ${fmt0(peakBpm)} bpm` };
  }
  return { usable: true, reason: "", beats: peaks.length, purity };
}

/**
 * Python's "%.0f", which breaks an exact tie to the even neighbour.
 *
 * Math.round breaks it toward +Infinity instead, so the two disagree whenever
 * that answer is odd, and the other candidate is r-1 in both signs. Python
 * also keeps the sign of a negative value that rounds to zero. Only refusal
 * messages reach this, but the harness compares those word for word.
 */
function fmt0(v) {
  const r = Math.round(v);
  const n = Math.abs(v - Math.trunc(v)) === 0.5 && r % 2 !== 0 ? r - 1 : r;
  return n === 0 && (v < 0 || Object.is(v, -0)) ? "-0" : String(n);
}

/**
 * Python's "%.1f".
 *
 * The only values sitting exactly halfway between two tenths are the odd
 * quarters -- 0.25, 0.75, 1.25 -- since a half-tenth is a dyadic rational
 * nowhere else. Python rounds those to the even tenth, toFixed rounds away
 * from zero. Multiplying by four is exact, so the test for the case is too.
 */
function fmt1(v) {
  const q = v * 4;
  if (Number.isInteger(q) && Math.abs(q) % 2 === 1) {
    const lo = Math.floor(v * 10);
    return ((lo % 2 === 0 ? lo : lo + 1) / 10).toFixed(1);
  }
  return v.toFixed(1);
}

/**
 * Run the whole pipeline over a recording already on the 30 Hz grid.
 *
 * Every candidate window is scored; the calmest one is the one we report.
 * Picking by purity rather than by the rate it produces keeps the choice
 * independent of the answer, so this cannot quietly select for a number.
 */
export function analyseGrid(values, fs = FS) {
  const raw = values instanceof Float64Array ? values : Float64Array.from(values);
  const total = raw.length;
  if (total < Math.max(Math.trunc(MIN_SECONDS * fs), 25)) {
    return { fs, peaks: [], quality: {
      usable: false,
      reason: `recording is ${fmt1(total / fs)} s; needs at least ${fmt0(MIN_SECONDS)} s`,
      beats: 0 } };
  }
  let n = Math.trunc(WINDOW_SECONDS * fs);
  let offsets;
  if (total <= n) {
    offsets = [0];
    n = total;
  } else {
    const step = Math.max(Math.trunc(WINDOW_STEP_SECONDS * fs), 1);
    offsets = [];
    for (let o = 0; o <= total - n; o += step) offsets.push(o);
  }

  let best = null;
  for (const off of offsets) {
    const x = bandpass(detrendNormalise(raw.subarray(off, off + n)), fs);
    const peaks = findBeats(x, fs);
    const q = signalQuality(x, peaks, fs);
    const score = "purity" in q ? q.purity : -1.0;
    if (best === null || score > best.score) best = { score, off, x, peaks, q };
  }

  const out = {
    fs,
    quality: best.q,
    peaks: best.peaks,
    filtered: best.x,
    window: { start_s: best.off / fs, seconds: n / fs, of_seconds: total / fs },
  };
  if (best.q.usable) Object.assign(out, irregularity(intervalsMs(best.peaks, fs)));
  return out;
}

/**
 * Camera samples in, rhythm out. The timestamps are the per-frame capture
 * times in milliseconds; they are the only reason this can run on hardware
 * whose frame rate is a suggestion rather than a promise.
 */
export function analyse(values, timestampsMs) {
  return analyseGrid(resampleTo30Hz(values, timestampsMs), FS);
}
