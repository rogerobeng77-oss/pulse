/* Wiring for the measurement console.
 *
 * Everything numeric happens in dsp.js, which is a line-for-line port of the
 * Python in ppg.py. This file only decides what to draw. The split matters:
 * the same arithmetic that produced the published validation numbers is the
 * arithmetic running in the browser, and verify_dsp.mjs proves it. */

import {
  analyse, resampleTo30Hz, detrendNormalise, bandpass,
  PURITY_MIN, AGREEMENT_TOL, WINDOW_SECONDS,
  HR_MIN_BPM, HR_MAX_BPM,
} from "./dsp.js";

const S = {
  samples: [],
  current: null,     // the analysed result being shown
  trace: null,       // { values, timestamps, label, ecg_bpm, expect }
  validation: null,
  view: "measure",
  recording: false,
};

const $ = id => document.getElementById(id);
const el = (tag, cls, txt) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (txt != null) n.textContent = txt;
  return n;
};

/* ------------------------------------------------------------------ boot */

async function boot() {
  const [samples, validation] = await Promise.all([
    fetch("samples/samples.json").then(r => r.json()),
    fetch("validation.json").then(r => r.json()).catch(() => null),
  ]);
  S.samples = samples;
  S.validation = validation;

  const sel = $("sample");
  samples.forEach((s, i) => {
    const o = el("option", null, `${s.title} · ${s.id}`);
    o.value = String(i);
    sel.appendChild(o);
  });
  sel.onchange = () => loadSample(Number(sel.value));

  document.querySelectorAll(".tabs button").forEach(b => {
    b.onclick = () => show(b.dataset.view);
  });
  $("replay").onclick = () => { if (S.trace) measure(S.trace); };
  $("camera").onclick = startCamera;

  loadSample(0);
}

function loadSample(i) {
  const s = S.samples[i];
  // The recordings are uniformly sampled at 30 Hz, so their timestamps are
  // synthetic here. A camera's are not, which is why the pipeline resamples.
  const timestamps = s.values.map((_, k) => (k * 1000) / s.fs);
  measure({
    values: s.values, timestamps, label: `${s.title} · record ${s.id}`,
    note: s.note, ecg_bpm: s.ecg_bpm, expect: s.expect, id: s.id,
  });
}

function measure(trace) {
  S.trace = trace;
  S.current = analyse(trace.values, trace.timestamps);
  $("srcpill").textContent = trace.fromCamera ? "Your camera" : "Recorded trace";
  $("toolnote").textContent = trace.note || "";
  const q = S.current.quality;
  $("statusright").textContent = q.usable
    ? `${S.current.hr_bpm.toFixed(1)} bpm · purity ${q.purity.toFixed(3)} · ${q.beats} beats`
    : `refused · ${q.reason}`;
  show("measure");
}

/* ----------------------------------------------------------------- views */

function show(view) {
  S.view = view;
  document.querySelectorAll(".tabs button")
    .forEach(b => b.classList.toggle("on", b.dataset.view === view));
  const main = $("main");
  main.innerHTML = "";
  ({ measure: viewMeasure, method: viewMethod,
     evidence: viewEvidence, limits: viewLimits }[view])(main);
}

function viewMeasure(main) {
  const r = S.current, q = r.quality, t = S.trace;

  const card = el("div", "card");
  const head = el("div", "card-head");
  const h = el("div");
  h.appendChild(el("h2", null, q.usable ? "Measured" : "Not measured"));
  h.appendChild(el("p", null, q.usable
    ? "Two independent estimates of the rate agreed and the trace held a single dominant pulse frequency, so this reading is reported."
    : `Nothing is reported for this recording. ${cap(q.reason)}.`));
  head.appendChild(h);
  const hr = el("div", "head-right");
  const v = el("span", `verdict ${q.usable ? "ok" : "no"}`);
  v.appendChild(el("i", null, q.usable ? "●" : "●"));
  v.appendChild(el("span", null, q.usable ? "Accepted" : "Refused"));
  hr.appendChild(v);
  head.appendChild(hr);
  card.appendChild(head);

  const stats = el("div", "stats");
  stats.appendChild(stat("Heart rate", q.usable ? r.hr_bpm.toFixed(1) : "—", q.usable ? "bpm" : "", !q.usable));
  stats.appendChild(stat("Beats found", String(q.beats), "", false));
  stats.appendChild(stat("Signal purity", (q.purity ?? 0).toFixed(3), `of ${PURITY_MIN}`, false));
  stats.appendChild(stat("Window measured",
    r.window ? `${r.window.start_s.toFixed(1)}–${(r.window.start_s + r.window.seconds).toFixed(1)}` : "—",
    r.window ? `s of ${r.window.of_seconds.toFixed(0)}` : "", false));
  card.appendChild(stats);

  const plot = el("div", "plot");
  const cv = el("canvas");
  plot.appendChild(cv);
  card.appendChild(plot);
  const lg = el("div", "plot-legend");
  lg.appendChild(legend("fill", "window measured"));
  lg.appendChild(legend("", "filtered pulse signal"));
  lg.appendChild(legend("dot", "detected beat"));
  card.appendChild(lg);
  main.appendChild(card);

  requestAnimationFrame(() => drawTrace(cv, r, t));

  main.appendChild(checksCard(r, t));
  if (t.ecg_bpm != null) main.appendChild(truthCard(r, t));
}

function stat(k, v, unit, dim) {
  const d = el("div", "stat");
  d.appendChild(el("div", "stat-k", k));
  const val = el("div", `stat-v${dim ? " dim" : ""}`, v);
  if (unit) val.appendChild(el("span", "stat-u", unit));
  d.appendChild(val);
  return d;
}

function legend(kind, text) {
  const s = el("span");
  s.appendChild(el("i", `sw ${kind}`.trim()));
  s.appendChild(el("span", null, text));
  return s;
}

function checksCard(r, t) {
  const q = r.quality;
  const card = el("div", "card");
  const head = el("div", "card-head");
  const h = el("div");
  h.appendChild(el("h2", null, "Why this recording was accepted or refused"));
  h.appendChild(el("p", null, "Four checks, in order. The first that fails stops the measurement — the tool reports nothing rather than a number it cannot stand behind."));
  head.appendChild(h);
  card.appendChild(head);

  const rows = el("div", "rows");
  const rh = el("div", "row-head");
  rh.appendChild(el("div", null, "Check"));
  rh.appendChild(el("div", null, "What it rules out"));
  rh.appendChild(el("div", null, "Result"));
  rows.appendChild(rh);

  const reason = q.reason || "";
  const beatsOk = q.beats >= 4;
  const rateOk = beatsOk && !reason.startsWith("implied rate");
  const purityOk = rateOk && q.purity != null && q.purity >= PURITY_MIN;
  const agreeOk = purityOk && !reason.startsWith("counted");

  rows.appendChild(check("At least four beats", "Three beats give two intervals, and two numbers say nothing about rhythm.",
    beatsOk ? "pass" : "fail", `${q.beats} found`));
  rows.appendChild(check("Rate is physiological", `Outside ${HR_MIN_BPM}–${HR_MAX_BPM} bpm it is noise, not a pulse.`,
    !beatsOk ? "skip" : rateOk ? "pass" : "fail", !beatsOk ? "—" : rateOk ? "in range" : "out of range"));
  rows.appendChild(check("One dominant pulse frequency", "A moving finger smears power across the band instead of concentrating it.",
    !rateOk ? "skip" : purityOk ? "pass" : "fail",
    q.purity != null ? q.purity.toFixed(3) : "—"));
  rows.appendChild(check("Two estimates agree",
    `Counting beats and reading the spectrum are independent. Requiring them within ${(AGREEMENT_TOL * 100).toFixed(0)}% is what catches half-rate errors from missed beats.`,
    !purityOk ? "skip" : agreeOk ? "pass" : "fail",
    !purityOk ? "—" : agreeOk ? "agree" : "disagree"));

  card.appendChild(rows);
  return card;
}

function check(name, why, state, value) {
  const row = el("div", "row");
  row.appendChild(el("div", "row-name", name));
  row.appendChild(el("div", "row-why", why));
  const t = el("div");
  t.appendChild(el("span", `tag ${state}`, value));
  row.appendChild(t);
  return row;
}

function truthCard(r, t) {
  const q = r.quality;
  const card = el("div", "card");
  const head = el("div", "card-head");
  const h = el("div");
  h.appendChild(el("h2", null, "Against the ECG recorded at the same moment"));
  const ours = q.usable ? r.hr_bpm : null;
  const diff = ours == null ? null : Math.abs(ours - t.ecg_bpm);
  h.appendChild(el("p", null, ours == null
    ? `This recording was refused. The ECG running alongside it gives ${t.ecg_bpm.toFixed(1)} bpm — so the refusal cost a reading that was there to be had, or avoided one that would have been wrong. Both happen, and the checks cannot tell which in advance.`
    : `The tool reports ${ours.toFixed(1)} bpm. The R-peaks on the simultaneous ECG give ${t.ecg_bpm.toFixed(1)} bpm, a difference of ${diff.toFixed(1)} bpm.`));
  head.appendChild(h);
  card.appendChild(head);

  if (t.expect) {
    const rows = el("div", "rows");
    const rh = el("div", "row-head");
    rh.appendChild(el("div", null, "Quantity"));
    rh.appendChild(el("div", null, "Python, on the same recording"));
    rh.appendChild(el("div", null, "This browser"));
    rows.appendChild(rh);
    const pairs = [
      ["Accepted", String(t.expect.usable), String(q.usable)],
      ["Heart rate", t.expect.bpm == null ? "—" : `${t.expect.bpm.toFixed(2)} bpm`,
        q.usable ? `${r.hr_bpm.toFixed(2)} bpm` : "—"],
      ["Signal purity", t.expect.purity.toFixed(4), (q.purity ?? 0).toFixed(4)],
    ];
    for (const [k, a, b] of pairs) {
      const row = el("div", "row");
      row.appendChild(el("div", "row-name", k));
      row.appendChild(el("div", "row-why", a));
      const tg = el("div");
      tg.appendChild(el("span", `tag ${a === b ? "pass" : "fail"}`, b));
      row.appendChild(tg);
      rows.appendChild(row);
    }
    card.appendChild(rows);
  }
  return card;
}

/* ------------------------------------------------------------------ plot */

function drawTrace(canvas, r, t) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const c = canvas.getContext("2d");
  c.scale(dpr, dpr);
  c.clearRect(0, 0, w, h);

  // `r.filtered` covers only the window that was measured. The chart shows the
  // whole recording so the chosen window can be seen in context, so the full
  // trace is filtered again here purely for display.
  let y;
  try {
    y = bandpass(detrendNormalise(resampleTo30Hz(t.values, t.timestamps)));
  } catch {
    y = t.values;
  }
  if (!y || !y.length) return;
  const n = y.length;
  let lo = Infinity, hi = -Infinity;
  for (const v of y) { if (v < lo) lo = v; if (v > hi) hi = v; }
  const pad = (hi - lo) * 0.12 || 1;
  lo -= pad; hi += pad;
  const X = i => (i / (n - 1)) * (w - 2) + 1;
  const Y = v => h - 16 - ((v - lo) / (hi - lo)) * (h - 30);

  // the stretch actually measured, behind everything else
  if (r.window) {
    const fs = r.fs || 30;
    const a = X(r.window.start_s * fs);
    const b = X((r.window.start_s + r.window.seconds) * fs);
    c.fillStyle = "#ddd9f8";
    c.fillRect(a, 6, Math.max(b - a, 1), h - 22);
  }

  c.strokeStyle = "#e5e7eb";
  c.lineWidth = 1;
  c.beginPath(); c.moveTo(0, h - 16); c.lineTo(w, h - 16); c.stroke();

  c.strokeStyle = "#4338ca";
  c.lineWidth = 1.6;
  c.lineJoin = "round";
  c.beginPath();
  for (let i = 0; i < n; i++) {
    const px = X(i), py = Y(y[i]);
    i ? c.lineTo(px, py) : c.moveTo(px, py);
  }
  c.stroke();

  // beat indices are relative to the window, so shift them onto the full trace
  const off = r.window ? Math.round(r.window.start_s * (r.fs || 30)) : 0;
  for (const p of (r.peaks || [])) {
    const idx = p + off;
    if (idx < 0 || idx >= n) continue;
    c.fillStyle = "#4338ca";
    c.beginPath(); c.arc(X(idx), Y(y[idx]), 3, 0, Math.PI * 2); c.fill();
  }

  c.fillStyle = "#9ca3af";
  c.font = "11px -apple-system, system-ui, sans-serif";
  c.fillText("0 s", 2, h - 3);
  const secs = (n / (r.fs || 30)).toFixed(0);
  c.fillText(`${secs} s`, w - 26, h - 3);
}

/* ---------------------------------------------------------------- camera */

async function startCamera() {
  if (S.recording) return;
  if (!navigator.mediaDevices?.getUserMedia) {
    alert("This browser will not give a page camera access.");
    return;
  }
  const main = $("main");
  main.innerHTML = "";
  const card = el("div", "card");
  const head = el("div", "card-head");
  const h = el("div");
  h.appendChild(el("h2", null, "Recording"));
  h.appendChild(el("p", null, "Cover the rear camera and its flash completely with a fingertip. Rest your hand on something solid and hold still — movement is what the tool refuses most often."));
  head.appendChild(h);
  card.appendChild(head);

  const cam = el("div", "cam");
  const video = el("video");
  video.autoplay = true; video.playsInline = true; video.muted = true;
  cam.appendChild(video);
  const side = el("div");
  const note = el("div", "cam-note");
  note.appendChild(el("strong", null, "Waiting for the camera…"));
  side.appendChild(note);
  const prog = el("div", "progress");
  const bar = el("i");
  prog.appendChild(bar);
  side.appendChild(prog);
  cam.appendChild(side);
  card.appendChild(cam);
  main.appendChild(card);

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" }, width: { ideal: 640 }, height: { ideal: 480 } },
      audio: false,
    });
  } catch (err) {
    note.textContent = `The camera was not available: ${err.message}`;
    return;
  }
  video.srcObject = stream;
  const track = stream.getVideoTracks()[0];
  // The flash is what makes a fingertip translucent enough to read. Not every
  // device exposes it, and a request that fails is not worth abandoning over.
  try { await track.applyConstraints({ advanced: [{ torch: true }] }); } catch { /* no torch */ }

  await video.play().catch(() => {});
  S.recording = true;
  $("camera").disabled = true;

  const SECONDS = 30;
  const cnv = document.createElement("canvas");
  cnv.width = 64; cnv.height = 64;
  const ctx = cnv.getContext("2d", { willReadFrequently: true });
  const values = [], timestamps = [];
  const t0 = performance.now();

  await new Promise(resolve => {
    const frame = () => {
      const now = performance.now();
      const secs = (now - t0) / 1000;
      if (secs >= SECONDS) return resolve();
      if (video.videoWidth) {
        // A small central crop: the edges of the frame catch stray light that
        // has not passed through the finger.
        const s = Math.min(video.videoWidth, video.videoHeight) * 0.4;
        ctx.drawImage(video, (video.videoWidth - s) / 2, (video.videoHeight - s) / 2, s, s, 0, 0, 64, 64);
        const d = ctx.getImageData(0, 0, 64, 64).data;
        let g = 0;
        for (let i = 1; i < d.length; i += 4) g += d[i];
        // green tracks haemoglobin absorption better than red, which saturates
        values.push(g / (d.length / 4));
        timestamps.push(now - t0);
      }
      bar.style.width = `${(secs / SECONDS) * 100}%`;
      note.innerHTML = "";
      note.appendChild(el("strong", null, `${(SECONDS - secs).toFixed(0)} seconds left`));
      note.appendChild(el("div", null, `${values.length} frames captured`));
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });

  stream.getTracks().forEach(t => t.stop());
  S.recording = false;
  $("camera").disabled = false;

  if (values.length < 60) {
    note.textContent = "Too few frames arrived to measure anything.";
    return;
  }
  measure({
    values, timestamps, fromCamera: true,
    label: "Your camera",
    note: `${values.length} frames over ${((timestamps.at(-1)) / 1000).toFixed(1)} s`,
  });
}

/* ------------------------------------------------------- static readings */

function viewMethod(main) {
  const card = el("div", "card");
  const head = el("div", "card-head");
  const h = el("div");
  h.appendChild(el("h2", null, "How the measurement works"));
  h.appendChild(el("p", null, "Arithmetic, not a model. Every step can be checked by hand."));
  head.appendChild(h);
  card.appendChild(head);
  const p = el("div", "prose");
  p.innerHTML = `
    <p>A fingertip over a lit camera changes brightness slightly with every heartbeat, as
    blood fills and leaves the tissue. The green channel carries that change most clearly.
    Reading a rate from it is easy. Knowing when the reading is wrong is the hard part,
    and that is what most of this pipeline does.</p>

    <h3>The pipeline</h3>
    <ul>
      <li><strong>Resample to 30 Hz.</strong> Camera frames do not arrive evenly. Everything
      downstream assumes a fixed rate, so the samples are interpolated onto a uniform grid
      first — which also makes the browser and the Python reproducible against each other.</li>
      <li><strong>Detrend and bandpass</strong> to ${HR_MIN_BPM}–${HR_MAX_BPM} bpm, a third-order
      Butterworth applied forwards and backwards so it adds no phase shift.</li>
      <li><strong>Find beats</strong> as peaks separated by at least a plausible beat interval.</li>
      <li><strong>Choose a window.</strong> ${WINDOW_SECONDS} seconds slide across the recording and
      the calmest one is measured. The window is picked by signal purity, never by the rate it
      produces, so the choice cannot quietly select for a particular answer.</li>
      <li><strong>Judge it</strong> against the four checks on the measurement page.</li>
    </ul>

    <h3>The check that matters most</h3>
    <div class="callout">Counting beats and reading the frequency spectrum are two independent
    ways to get the same number. When a finger moves, the beat detector tends to miss alternate
    beats and report half the true rate — which looks exactly like a genuinely slow pulse and
    cannot be spotted from the rate alone. Requiring the two methods to agree within
    ${(AGREEMENT_TOL * 100).toFixed(0)}% is what separates them. On the validation corpus this
    check alone refuses 117 recordings, and those are disproportionately the ones the tool
    would otherwise have got badly wrong.</div>

    <h3>Why the same code runs in both places</h3>
    <p>The numbers on the evidence page were produced by <code>ppg.py</code>. The numbers in this
    page come from <code>dsp.js</code>. If those two drifted apart, the published accuracy would
    describe software nobody is running. <code>verify_dsp.mjs</code> runs both over real recordings
    and compares the filtered signal, the beat positions, the rate, the purity and the accept
    decision. Each demo recording also carries the values Python produced, and the measurement
    page shows them next to what your browser just computed.</p>`;
  groupSections(p);
  card.appendChild(p);
  main.appendChild(card);
}

function viewEvidence(main) {
  const v = S.validation;
  const card = el("div", "card");
  const head = el("div", "card-head");
  const h = el("div");
  h.appendChild(el("h2", null, "What was measured, and against what"));
  h.appendChild(el("p", null, v
    ? `${v.records_analysed.toLocaleString()} smartphone recordings from ${v.dataset}, each with a simultaneous ECG. The reference rate comes from ${v.reference}.`
    : "Validation numbers are unavailable."));
  head.appendChild(h);
  card.appendChild(head);

  if (v) {
    const stats = el("div", "stats");
    const a = v.heart_rate_on_accepted, g = v.quality_gate;
    stats.appendChild(stat("Recordings", v.records_analysed.toLocaleString(), "", false));
    stats.appendChild(stat("Refused correctly", (g.specificity * 100).toFixed(1), "%", false));
    stats.appendChild(stat("Within 5 bpm", (a.within_5_bpm * 100).toFixed(1), "% of accepted", false));
    stats.appendChild(stat("Median error", a.median_bpm.toFixed(2), "bpm", false));
    card.appendChild(stats);

    const p = el("div", "prose");
    p.innerHTML = `
      <h3>The quality gate</h3>
      <p>Of ${v.records_analysed.toLocaleString()} recordings, expert annotators called
      ${g.annotator_good.toLocaleString()} usable. The tool accepts ${a.n}. It refuses
      ${(g.specificity * 100).toFixed(1)}% of what the annotators refuse, and accepts only
      ${(g.sensitivity * 100).toFixed(1)}% of what they accept — deliberately far stricter than
      a human grader, because a refusal costs a retake and a wrong rate costs trust.</p>

      <h3>Rate accuracy on what it accepts</h3>
      <p>Mean absolute error ${a.mae_bpm} bpm, median ${a.median_bpm} bpm,
      ${(a.within_5_bpm * 100).toFixed(1)}% within 5 bpm and
      ${(a.within_10_bpm * 100).toFixed(1)}% within 10 bpm of the ECG. The mean sits well above
      the median because a handful of accepted recordings are badly wrong rather than slightly
      wrong; that tail is the honest weakness here, and it is reported rather than trimmed.</p>

      <h3>Accuracy is limited by length, not by method</h3>
      <p>Holding the gate fixed and varying only how much signal it sees, the share of rates
      landing within 5 bpm of the ECG runs:</p>
      <ul>${Object.entries(v.duration_trend_within_5bpm)
        .map(([k, val]) => `<li><code>${k}</code> window — ${(val * 100).toFixed(0)}% within 5 bpm</li>`).join("")}</ul>
      <p>Every recording in this corpus is ten seconds long, which is the ceiling of that
      table. The app records thirty. That the trend continues is an extrapolation, not a
      measurement, and it is listed on the limits page as such.</p>

      <h3>Measuring the calmest window helps</h3>
      <p>Sliding an eight-second window and measuring the calmest stretch, rather than the first
      one, raised the number of usable recordings from
      ${v.window_selection.fixed_8s.n} to ${v.window_selection.cleanest_8s.n} while
      <em>also</em> improving mean error from ${v.window_selection.fixed_8s.mae} to
      ${v.window_selection.cleanest_8s.mae} bpm.</p>

      <h3>On the reference</h3>
      <p>The dataset ships its own heart-rate column, and this project does not use it. That
      column is doubled for one subject and differs from the ECG's own R-peak annotations by
      2.98 bpm on average. Scoring against it charges the tool for the reference's mistakes as
      well as its own, so the R-peaks are used instead.</p>`;
    groupSections(p);
    card.appendChild(p);
  }
  main.appendChild(card);
}

function viewLimits(main) {
  const card = el("div", "card");
  const head = el("div", "card-head");
  const h = el("div");
  h.appendChild(el("h2", null, "What this is not"));
  h.appendChild(el("p", null, "Finished work and planned work, kept apart."));
  head.appendChild(h);
  card.appendChild(head);
  const p = el("div", "prose");
  const limits = (S.validation?.honest_limits || []).map(l => `<li>${l}</li>`).join("");
  p.innerHTML = `
    <div class="callout"><strong>This is not a medical device and does not diagnose anything.</strong>
    It reports a pulse rate and a description of how evenly spaced the beats were, or it reports
    nothing at all.</div>

    <h3>Measured limits</h3>
    <ul>${limits}</ul>

    <h3>Finished</h3>
    <ul>
      <li>The signal pipeline, validated on ${(S.validation?.records_analysed ?? 0).toLocaleString()} recordings against simultaneous ECG.</li>
      <li>The quality gate and its four checks.</li>
      <li>Camera capture in the browser, and the same arithmetic running in Python and in JavaScript, verified against each other.</li>
    </ul>

    <h3>Not finished</h3>
    <ul>
      <li>Any validation of the irregularity measures as a screen for atrial fibrillation. The
      corpus has no rhythm labels, so <code>rmssd</code> and the interval spread are computed and
      described but never interpreted.</li>
      <li>Any measurement on recordings longer than ten seconds. The thirty-second capture is
      built and works; its accuracy is inferred from the duration trend, not established.</li>
      <li>Any testing across skin tones, nail polish, cold hands, or camera hardware. The corpus
      is one cohort recorded on a small number of devices, and PPG is known to behave differently
      across skin tones. Nothing here characterises that.</li>
    </ul>`;
  groupSections(p);
  card.appendChild(p);
  main.appendChild(card);
}

const cap = s => s ? s[0].toUpperCase() + s.slice(1) : s;

/* Two-column prose balances by element, which happily strands a heading at the
   foot of one column and its list at the head of the next. Grouping everything
   under a heading into one block keeps each section whole. */
function groupSections(root) {
  const kids = [...root.childNodes];
  let section = null;
  for (const node of kids) {
    if (node.nodeName === "H3") {
      section = document.createElement("section");
      root.insertBefore(section, node);
    }
    if (section) section.appendChild(node);
  }
}

boot();
