# Pulse

A pulse reading taken through a phone camera that refuses to answer when it cannot answer well.

Covering a rear camera and its flash with a fingertip produces a faint brightness change with
every heartbeat. Reading a rate from that is easy, and consumer apps do it confidently on
recordings that contain no usable signal at all. This does the opposite: most of the code exists
to decide whether the recording is measurable, and the common correct answer is no.

## What the numbers are

Validated on [BUT PPG 2.0.0](https://physionet.org/content/butppg/2.0.0/) — 3,840 smartphone
recordings, each with a simultaneous ECG. The reference heart rate comes from the ECG's own
R-peak annotations over the same window.

| | |
|---|---|
| Recordings analysed | 3,840 |
| Refuses what expert annotators refuse | 98.1% |
| Accepts what they accept | 18.2% |
| Recordings accepted | 202 (5.3%) |
| Rate within 5 bpm of ECG, on accepted | 85.1% |
| Median error, on accepted | 0.93 bpm |
| Mean absolute error, on accepted | 6.11 bpm |

The mean sits far above the median because a handful of accepted recordings are badly wrong
rather than slightly wrong. That tail is the honest weakness here and it is reported, not
trimmed. Accepting 5.3% of a deliberately noisy corpus is the price of the first row.

Reproduce with `python validate.py`, which writes `validation.json` and the copy the web app
reads.

## The check that does the work

Counting beats and reading the frequency spectrum are independent estimates of the same number.
When a finger moves, the beat detector misses alternate beats and reports half the true rate —
indistinguishable from a genuinely slow pulse if you only look at the rate. Requiring the two to
agree within 5% is what separates them, and it refuses 117 recordings that would otherwise have
produced confident, wrong answers.

## Accuracy is limited by length, not by method

Gate held fixed, only the window length varied:

| Window | Within 5 bpm of ECG |
|---|---|
| 4 s | 61% |
| 6 s | 74% |
| 8 s | 82% |
| 10 s | 90% |

Every recording in this corpus is ten seconds, which is the ceiling of that table. The app
records thirty. **That the trend continues past ten seconds is an extrapolation, not a
measurement.**

Sliding an eight-second window and measuring the calmest stretch rather than the first raised
usable recordings from 149 to 204 while also improving mean error from 7.33 to 6.38 bpm.

## The same arithmetic in both languages

`ppg.py` produced the numbers above. `dsp.js` runs in the browser. If they drifted, the published
accuracy would describe software nobody runs. `verify_dsp.mjs` runs both over real recordings and
compares the filtered signal, beat positions, rate, purity and accept decision. Each demo
recording also ships the values Python produced, and the app shows them beside what the browser
computed.

The browser pipeline is fixed at 30 Hz and uses hardcoded filter coefficients, because camera
frame timing varies by device and a filter designed on the fly cannot be verified against Python.

## What this is not

Not a medical device. It does not diagnose anything. It reports a pulse rate and a description
of how evenly spaced the beats were, or it reports nothing.

Not validated as an atrial-fibrillation screen. The corpus has no rhythm labels, so the
irregularity measures are computed and described but never interpreted.

Not characterised across skin tones, cold hands, nail polish, or camera hardware. One cohort, a
small number of handsets. PPG is known to behave differently across skin tones and nothing here
measures that.

A refusal says the recording could not be measured. It says nothing about the person.

## Layout

```
ppg.py            the pipeline and the gate
butppg_io.py      WFDB readers for the corpus
validate.py       the numbers above
web/dsp.js        the JavaScript port
verify_dsp.mjs    proof the two agree
web/              the measurement console
```

## Data

BUT PPG 2.0.0, Nemcova et al., PhysioNet, CC-BY 4.0. Not redistributed here; `validate.py`
expects it under `data/butppg/`.

## Licence

The code here is MIT licensed — see [LICENSE](LICENSE).

The demo traces in `web/samples/samples.json` come from the BUT PPG database and are
redistributed under **CC-BY 4.0**, attributed to Nemcova A, Vargova E, Smisek R, et al., *Brno
University of Technology Smartphone PPG Database (BUT PPG)*, PhysioNet v2.0.0. The database
itself is not redistributed.

**Not a medical device.** Provided as-is, for research and demonstration. It reports a pulse
rate or nothing at all, and diagnoses nothing.
