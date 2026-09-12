# Pulse — Devpost submission

## Form fields

**Project name:** Pulse
**Tagline:** A pulse reading from a phone camera that refuses to answer when it cannot answer well.
**Live demo:** https://d1kvjmmokxigdv.cloudfront.net
**Repository:** https://github.com/rogerobeng77-oss/pulse
**One-page PDF:** docs/onepager.pdf
**Video:** (under 3:00)
**Built with:** scipy, NumPy, vanilla JavaScript, getUserMedia, S3, CloudFront

---

## Elevator pitch

Every phone can read a pulse from a fingertip over the camera, and every app that does it will
confidently give you a number from a recording that contains no pulse at all. Pulse is the same
measurement with the opposite priority: on a public dataset of 3,840 smartphone recordings it
refuses 98.1% of what expert annotators refuse, and when it does answer, 85.1% of its readings
land within 5 bpm of a simultaneous ECG.

---

## The story

Put a fingertip over a phone's rear camera with the flash on and the image brightens and dims
very slightly with each heartbeat, as blood fills and leaves the tissue. Reading a rate off that
is a first-year signal processing exercise.

Knowing when the reading is *wrong* is the entire problem, and almost nothing does it.

The dataset makes the point. BUT PPG is 3,888 smartphone recordings, each with a simultaneous
ECG and an expert quality grade. Of those, the annotators marked only 795 usable. Most
smartphone PPG recordings are not measurable. A tool that always returns a number is therefore
wrong most of the time, and says so with total confidence.

So the majority of this project is a refusal.

## The check that does the real work

Counting beats and reading the frequency spectrum are two independent ways to get the same
number. When a finger moves, the beat detector tends to miss alternate beats and report half the
true rate — which looks exactly like a genuinely slow pulse and cannot be spotted from the rate
alone.

Requiring the two estimates to agree within 5% is what separates them. On the corpus that single
check refuses 117 recordings, and they are disproportionately the ones the tool would otherwise
have got badly wrong. One of the demo recordings is exactly this case: it would have reported
45 bpm against an ECG truth of 67, and instead it reports nothing.

## The numbers

Validated against heart rates derived from the **ECG's own R-peak annotations** over the same
window.

| | |
|---|---|
| Recordings analysed | 3,840 |
| Refuses what expert annotators refuse | **98.1%** |
| Recordings accepted | 202 (5.3%) |
| Rate within 5 bpm of ECG | **85.1%** |
| Median absolute error | **0.93 bpm** |
| Mean absolute error | 6.11 bpm |

Two of those rows deserve to be read properly.

**5.3% is low, and it is the point.** The corpus is deliberately noisy. Accepting one recording
in twenty is the price of not reporting a wrong rate, and it is quoted as a headline rather than
buried.

**The mean is six times the median** because a handful of accepted recordings are badly wrong
rather than slightly wrong. That tail is the honest weakness of this project and it is printed
next to the good number.

## Two findings that changed the design

**Accuracy is limited by recording length, not by method.** Holding the gate fixed and varying
only the window: 61% within 5 bpm at 4 seconds, 74% at 6, 82% at 8, 90% at 10. Every recording
in the corpus is ten seconds, which is the ceiling of that table. The app records thirty — and
the limits page says plainly that the trend continuing past ten seconds is an extrapolation, not
a measurement.

**Measuring the calmest window beats measuring the first one.** Sliding an eight-second window
and taking the calmest stretch raised accepted recordings from 149 to 204 while *also* improving
mean error from 7.33 to 6.38 bpm. The window is chosen by signal purity, never by the rate it
produces, so the choice cannot quietly select for an answer.

## The dataset's own heart rates are wrong, so they are not used

BUT PPG ships an HR column. Pulse does not score against it. Compared with the ECG R-peak
annotations it differs by 2.98 bpm on average, and for one subject it is roughly doubled — record
142036 has R-peaks at 72.4 bpm and a column reading of 159.

Scoring against that column charges the tool for the reference's mistakes as well as its own. An
earlier version of this project did exactly that, and it made the results look worse than they
were.

## The browser and the Python compute the same thing

The published accuracy comes from `ppg.py`. The page runs `dsp.js`. If those drifted, the
accuracy would describe software nobody is running. A harness runs both over real recordings and
compares every intermediate value. Across **418 traces and 1,570 candidate windows**: the
filtered signal, heart rate, rmssd, sdnn, cv and pnn50 diverge by **exactly 0.0**; spectral
purity by 6.7e-16; beat positions, the accept decision, the chosen window and the refusal text
are **100% identical**.

Each demo recording also carries the values Python produced, and the app shows them beside what
your browser just computed, so you can see the agreement without running anything.

## Challenges

**My first accuracy figure was measured on a flattering subset.** I reported 5.01 bpm error —
computed only over recordings that both the tool and the annotators called good. Across
everything the tool would actually accept it was 10–16 bpm. Finding that out meant throwing away
the number I liked.

**My hypothesis about why it was wrong was also wrong.** I assumed peak-counting on short noisy
traces was the culprit and that a spectral estimate would do better. It did not: 27.2 bpm mean
error against peak-counting's 17.9. I kept peak-counting.

**A quality metric that separated nothing.** A beat-template similarity score is the classic
signal-quality index, so I implemented it. Accepted-and-correct traces scored a median 0.990;
accepted-and-badly-wrong traces scored 0.984. It could not tell them apart, because those beats
are self-consistent — just self-consistently wrong. It is not in the shipped gate.

**A gate that admitted traces it could not measure.** Three detected beats passed the quality
check but produce only two intervals, which is not enough to describe a rhythm. Requiring four
fixed it and slightly improved every metric.

## What it does not do

It does not diagnose anything. It reports a rate and a description of how evenly spaced the
beats were, or it reports nothing.

**It is not an atrial fibrillation screen.** The corpus has no rhythm labels. The irregularity
measures are computed and described, never interpreted, and no claim is made that they detect
anything.

Nothing here is characterised across skin tones, cold hands, or other camera hardware. PPG is
known to behave differently across skin tones and this corpus is one cohort on a few handsets.
That is a real limitation, not a hypothetical one.

A refusal says the recording could not be measured. It says nothing about the person holding the
phone.

## What I learned

That "I don't know" is a feature you have to design for from the beginning, and that most of the
engineering ends up on that side. Also that the reference is a measurement too, and can be wrong
in ways that quietly punish you.

## What's next

Validation on recordings longer than ten seconds, which is the one claim currently resting on
extrapolation. Rhythm labels, without which the irregularity half of this cannot honestly be
called a screen. And a deliberate look at performance across skin tones, which is the gap most
likely to matter to whoever uses it.

## Try it

https://d1kvjmmokxigdv.cloudfront.net — four real recordings with their ECG ground truth, or use
your own camera. Testing instructions in `docs/testing-instructions.md`; every source in
`docs/sources.md`.
