/**
 * Does web/dsp.js actually agree with ppg.py?
 *
 * Run dsp_ref.py first; it writes dsp_fixtures.json from real BUT PPG green
 * traces. This replays every one of them through the JavaScript and compares
 * the whole pipeline against the Python, quantity by quantity, and prints the
 * worst case for each. It reports what it finds rather than asserting that
 * everything is fine.
 *
 *   .venv/bin/python dsp_ref.py && node verify_dsp.mjs
 */

import { readFileSync } from "node:fs";
import * as dsp from "./web/dsp.js";

const fixtures = JSON.parse(readFileSync(new URL("./dsp_fixtures.json", import.meta.url), "utf8"));
const units = JSON.parse(readFileSync(new URL("./dsp_unit_fixtures.json", import.meta.url), "utf8"));

const BARS = {
  filtered: 1e-9,   // relative to the signal's own scale
  scalar: 1e-6,     // hr, purity, rmssd, cv
  beats: 0.95,      // fraction of traces with identical beat indices
};

/** Worst absolute difference between two same-length sequences. */
function maxAbsDiff(a, b) {
  if (a.length !== b.length) return { diff: Infinity, at: -1, lenMismatch: [a.length, b.length] };
  let diff = 0;
  let at = -1;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d > diff) { diff = d; at = i; }
  }
  return { diff, at };
}

/** Pearson correlation, as a sanity check that any divergence is noise not shape. */
function correlation(a, b) {
  const n = a.length;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - ma;
    const db = b[i] - mb;
    sab += da * db; saa += da * da; sbb += db * db;
  }
  if (saa === 0 || sbb === 0) return saa === sbb ? 1 : 0;
  return sab / Math.sqrt(saa * sbb);
}

function scale(a) {
  let m = 0;
  for (const v of a) m = Math.max(m, Math.abs(v));
  return m > 0 ? m : 1;
}

/** Tracks the worst offender for one compared quantity. */
class Worst {
  constructor(name) { this.name = name; this.n = 0; this.value = 0; this.id = "-"; this.note = ""; }
  see(id, value, note = "") {
    this.n++;
    if (value > this.value) { this.value = value; this.id = id; this.note = note; }
  }
}

const worst = {
  gridAbs: new Worst("resampled grid, max abs diff"),
  fullRel: new Worst("filtfilt over the whole trace, max abs diff / scale"),
  winRel: new Worst("filtfilt over the chosen window, max abs diff / scale"),
  purity: new Worst("spectral purity, abs diff"),
  hr: new Worst("heart rate bpm, abs diff"),
  rmssd: new Worst("rmssd ms, abs diff"),
  cv: new Worst("cv, abs diff"),
  sdnn: new Worst("sdnn ms, abs diff"),
  pnn50: new Worst("pnn50, abs diff"),
  sweepPurity: new Worst("purity, every candidate window, abs diff"),
};
// The window choice is an argmax over purities. It only means anything if the
// gap it decides by is far larger than the disagreement between the two
// implementations, so both are measured. Traces where no window reached the
// four-beat gate score -1.0 everywhere and are decided by order, not by
// arithmetic -- counted separately rather than reported as a zero margin.
let minMargin = Infinity;
let minMarginId = "-";
let sentinelDecided = 0;
let minCorrFull = 1;
let minCorrWin = 1;
let minCorrFullId = "-";

const windowSweepMismatches = [];
let windowsCompared = 0;
const beatMismatches = [];
const usableMismatches = [];
const offsetMismatches = [];
const reasonMismatches = [];
let beatsCompared = 0;
let beatsIdentical = 0;
let tiesTotal = 0;

for (const f of fixtures) {
  tiesTotal += f.height_ties;

  const grid = dsp.resampleTo30Hz(f.values, f.timestamps_ms);
  worst.gridAbs.see(f.id, maxAbsDiff(grid, f.grid).diff);

  const res = dsp.analyse(f.values, f.timestamps_ms);

  if (!f.too_short) {
    const full = dsp.bandpass(dsp.detrendNormalise(grid));
    worst.fullRel.see(f.id, maxAbsDiff(full, f.filtered_full).diff / scale(f.filtered_full));
    const cFull = correlation(full, f.filtered_full);
    if (cFull < minCorrFull) { minCorrFull = cFull; minCorrFullId = f.id; }

    worst.winRel.see(f.id, maxAbsDiff(res.filtered, f.filtered_window).diff / scale(f.filtered_window));
    minCorrWin = Math.min(minCorrWin, correlation(res.filtered, f.filtered_window));

    if (res.window.start_s * dsp.FS !== f.window_offset) {
      offsetMismatches.push(`${f.id}: js ${res.window.start_s * dsp.FS} vs py ${f.window_offset}`);
    }
    if (res.window.seconds !== f.window_seconds) {
      offsetMismatches.push(`${f.id}: window length js ${res.window.seconds} vs py ${f.window_seconds}`);
    }
    // Every candidate window, not only the one analyse kept.
    for (const w of f.windows) {
      windowsCompared++;
      const x = dsp.bandpass(dsp.detrendNormalise(grid.subarray(w.off, w.off + f.window_len)));
      const pk = dsp.findBeats(x);
      const q = dsp.signalQuality(x, pk);
      const [pur, bpm] = dsp.spectralPurity(x);
      const score = "purity" in q ? q.purity : -1.0;
      const problems = [];
      if (pk.length !== w.peaks.length || pk.some((v, i) => v !== w.peaks[i])) {
        problems.push(`peaks js ${JSON.stringify(pk)} vs py ${JSON.stringify(w.peaks)}`);
      }
      worst.sweepPurity.see(`${f.id}@${w.off}`, Math.abs(pur - w.purity));
      if (Math.abs(pur - w.purity) > BARS.scalar) problems.push(`purity ${Math.abs(pur - w.purity)}`);
      if (Math.abs(bpm - w.peak_bpm) > BARS.scalar) problems.push(`peak bpm ${Math.abs(bpm - w.peak_bpm)}`);
      if (Math.abs(score - w.score) > BARS.scalar) problems.push(`score js ${score} vs py ${w.score}`);
      if ((score === -1.0) !== (w.score === -1.0)) problems.push(`one side scored the window as unmeasurable`);
      if (q.usable !== w.usable) problems.push(`usable js ${q.usable} vs py ${w.usable}`);
      if ((q.reason ?? "") !== w.reason) problems.push(`reason js "${q.reason}" vs py "${w.reason}"`);
      if (problems.length) windowSweepMismatches.push(`${f.id} off=${w.off}: ${problems.join("; ")}`);
    }
    const scores = f.windows.map((w) => w.score).sort((a, b) => b - a);
    if (scores[0] === -1.0) {
      sentinelDecided++;
    } else if (scores.length > 1 && scores[0] - scores[1] < minMargin) {
      minMargin = scores[0] - scores[1];
      minMarginId = f.id;
    }
  } else if (res.window !== undefined) {
    offsetMismatches.push(`${f.id}: js produced a window for a trace Python refused as too short`);
  }

  beatsCompared++;
  const same = res.peaks.length === f.peaks.length && res.peaks.every((p, i) => p === f.peaks[i]);
  if (same) beatsIdentical++;
  else beatMismatches.push({ id: f.id, js: res.peaks, py: f.peaks, ties: f.height_ties });

  if (res.quality.usable !== f.usable) {
    usableMismatches.push(`${f.id}: js ${res.quality.usable} (${res.quality.reason}) vs py ${f.usable} (${f.reason})`);
  }
  if ((res.quality.reason ?? "") !== (f.reason ?? "")) {
    reasonMismatches.push(`${f.id}: js "${res.quality.reason}" vs py "${f.reason}"`);
  }

  const pairs = [
    [worst.purity, "purity" in res.quality ? res.quality.purity : null, f.purity],
    [worst.hr, res.hr_bpm ?? null, f.hr_bpm],
    [worst.rmssd, res.rmssd_ms ?? null, f.rmssd_ms],
    [worst.cv, res.cv ?? null, f.cv],
    [worst.sdnn, res.sdnn_ms ?? null, f.sdnn_ms],
    [worst.pnn50, res.pnn50 ?? null, f.pnn50],
  ];
  for (const [w, js, py] of pairs) {
    if (js === null && py === null) continue;
    if (js === null || py === null) { w.see(f.id, Infinity, `defined on one side only: js=${js} py=${py}`); continue; }
    w.see(f.id, Math.abs(js - py));
  }
}

// --- adversarial signals: plateaus, exact ties, degenerate spectra ---------
const unitProblems = [];
const unitTieNotes = [];
let unitTies = 0;
let unitTieBreakDiffs = 0;
const unitWorst = {
  detrended: new Worst("detrend_normalise, max abs diff"),
  filt: new Worst("filtfilt, max abs diff / scale"),
  purity: new Worst("spectral purity, abs diff"),
  bpm: new Worst("spectral peak bpm, abs diff"),
};
for (const u of units) {
  unitTies += u.height_ties;
  const x = Float64Array.from(u.x);
  unitWorst.detrended.see(u.name, maxAbsDiff(dsp.detrendNormalise(x), u.detrended).diff);
  unitWorst.filt.see(u.name, maxAbsDiff(dsp.bandpass(x), u.filtfilt).diff / scale(u.filtfilt));

  const pk = dsp.findBeats(x);
  const eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
  const samePeaks = eq(pk, u.peaks);
  if (!samePeaks) {
    // The one licence to differ: peaks of exactly equal height inside one
    // exclusion zone, which scipy resolves with an unstable sort. To count as
    // that and not as a bug, the JS must reproduce scipy-with-a-stable-sort
    // exactly -- same peaks, not merely plausible ones.
    if (u.height_ties > 0 && eq(pk, u.peaks_stable)) {
      unitTieBreakDiffs++;
      unitTieNotes.push(`${u.name}: ${u.height_ties} exact-height ties; ` +
                        `js matches scipy-with-stable-sort exactly, differs from scipy-as-shipped at ` +
                        `${pk.filter((v, i) => v !== u.peaks[i]).length} of ${pk.length} beats`);
    } else {
      unitProblems.push(`${u.name}: peaks differ and it is NOT the tie-break ` +
                        `(ties=${u.height_ties}, matches stable=${eq(pk, u.peaks_stable)})\n` +
                        `    js       ${JSON.stringify(pk)}\n    py       ${JSON.stringify(u.peaks)}\n` +
                        `    py-stable ${JSON.stringify(u.peaks_stable)}`);
    }
  } else if (!eq(pk, u.peaks_stable)) {
    unitProblems.push(`${u.name}: matches scipy but not scipy-with-stable-sort - the harness is wrong`);
  }

  const [pur, bpm] = dsp.spectralPurity(x);
  unitWorst.purity.see(u.name, Math.abs(pur - u.purity));
  unitWorst.bpm.see(u.name, Math.abs(bpm - u.peak_bpm));

  const ibi = dsp.intervalsMs(pk);
  if (samePeaks) {
    const d = maxAbsDiff(ibi, u.ibi).diff;
    if (d !== 0) unitProblems.push(`${u.name}: intervals differ by ${d}`);
    const irr = dsp.irregularity(ibi);
    for (const k of Object.keys(u.irregularity)) {
      const a = irr[k];
      const b = u.irregularity[k];
      if (a === undefined) { unitProblems.push(`${u.name}: irregularity missing ${k}`); continue; }
      if (Math.abs(a - b) > BARS.scalar) unitProblems.push(`${u.name}: ${k} js ${a} vs py ${b}`);
    }
    const q = dsp.signalQuality(x, pk);
    for (const k of Object.keys(u.quality)) {
      const a = q[k];
      const b = u.quality[k];
      const ok = typeof b === "number" ? Math.abs(a - b) <= BARS.scalar : a === b;
      if (!ok) unitProblems.push(`${u.name}: quality.${k} js ${JSON.stringify(a)} vs py ${JSON.stringify(b)}`);
    }
  }
}

const pad = (s, n) => String(s).padEnd(n);
const line = "-".repeat(78);

console.log(line);
console.log(`ppg.py -> web/dsp.js  |  ${fixtures.length} real BUT PPG traces, 30 Hz grid`);
console.log(`${fixtures.filter((f) => f.too_short).length} of them truncated below the minimum duration, ` +
            `${fixtures.filter((f) => !f.too_short && f.window_len < 240).length} shorter than one window`);
console.log(`usable in Python: ${fixtures.filter((f) => f.usable).length}   ` +
            `exact peak-height ties found anywhere: ${tiesTotal}`);
console.log(line);

for (const w of Object.values(worst)) {
  console.log(`${pad(w.name, 52)} ${w.value.toExponential(3)}  (${w.n} traces, worst ${w.id})${w.note ? "  " + w.note : ""}`);
}
console.log(`${pad("purity margin the window choice turns on (min)", 52)} ${minMargin.toExponential(3)}  (${minMarginId})`);
console.log(`${pad("traces where no window passed the beat gate", 52)} ${sentinelDecided}  (window picked by order, identically in both)`);
console.log(`${pad("filtfilt correlation, whole trace (min)", 52)} ${minCorrFull.toFixed(15)}  (${minCorrFullId})`);
console.log(`${pad("filtfilt correlation, chosen window (min)", 52)} ${minCorrWin.toFixed(15)}`);
console.log(line);

const beatRate = beatsIdentical / beatsCompared;
console.log(`beat indices identical      : ${beatsIdentical}/${beatsCompared}  (${(beatRate * 100).toFixed(2)}%)`);
console.log(`usable flag agrees          : ${fixtures.length - usableMismatches.length}/${fixtures.length}`);
console.log(`refusal reason string agrees: ${fixtures.length - reasonMismatches.length}/${fixtures.length}`);
console.log(`chosen window offset agrees : ${fixtures.length - offsetMismatches.length}/${fixtures.length}`);
console.log(`every candidate window agrees: ${windowsCompared - windowSweepMismatches.length}/${windowsCompared}  ` +
            `(peaks, purity, peak bpm, score, usable, reason)`);

for (const [label, list] of [["BEAT", beatMismatches.map((m) =>
        `${m.id}: ties=${m.ties}\n    js ${JSON.stringify(m.js)}\n    py ${JSON.stringify(m.py)}`)],
      ["USABLE", usableMismatches], ["REASON", reasonMismatches], ["OFFSET", offsetMismatches],
      ["WINDOW SWEEP", windowSweepMismatches]]) {
  if (!list.length) continue;
  console.log(`\n${label} MISMATCHES (${list.length}):`);
  for (const m of list.slice(0, 20)) console.log("  " + m);
  if (list.length > 20) console.log(`  ... and ${list.length - 20} more`);
}

console.log(line);
console.log(`ADVERSARIAL SIGNALS (${units.length}): plateaus, quantised levels, constants, spikes`);
console.log(`  exact peak-height ties inside an exclusion zone: ${unitTies}`);
for (const w of Object.values(unitWorst)) {
  console.log(`  ${pad(w.name, 44)} ${w.value.toExponential(3)}  (worst ${w.id})`);
}
console.log(`  signals where the beat set differs: ${unitTieBreakDiffs}/${units.length}, all attributed:`);
for (const m of unitTieNotes) console.log(`    ${m}`);
if (unitProblems.length) {
  console.log("  PROBLEMS:");
  for (const m of unitProblems) console.log("    " + m);
} else {
  console.log("  nothing unaccounted for");
}
console.log(line);
const checks = [
  ["resampled grid bit-identical", worst.gridAbs.value === 0],
  [`filtfilt (full) < ${BARS.filtered}`, worst.fullRel.value < BARS.filtered],
  [`filtfilt (window) < ${BARS.filtered}`, worst.winRel.value < BARS.filtered],
  [`beat indices identical >= ${BARS.beats * 100}%`, beatRate >= BARS.beats],
  [`heart rate < ${BARS.scalar}`, worst.hr.value < BARS.scalar],
  [`purity < ${BARS.scalar}`, worst.purity.value < BARS.scalar],
  [`rmssd < ${BARS.scalar}`, worst.rmssd.value < BARS.scalar],
  [`cv < ${BARS.scalar}`, worst.cv.value < BARS.scalar],
  ["usable flag 100%", usableMismatches.length === 0],
  ["window offset 100%", offsetMismatches.length === 0],
  ["every candidate window 100%", windowSweepMismatches.length === 0],
  ["adversarial signals clean", unitProblems.length === 0],
];
let failed = 0;
for (const [name, ok] of checks) {
  if (!ok) failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
}
console.log(line);
console.log(failed === 0 ? "ALL BARS MET" : `${failed} BAR(S) NOT MET`);
process.exit(failed === 0 ? 0 : 1);
