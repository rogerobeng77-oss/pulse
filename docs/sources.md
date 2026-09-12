# Pulse — sources

Every factual claim, with where it came from. The numbers describing Pulse itself are produced
by code in this repository and can be regenerated; the command is given beside each.

## The data

Nemcova A, Vargova E, Smisek R, et al. **Brno University of Technology Smartphone PPG Database
(BUT PPG).** PhysioNet, version 2.0.0. Licensed CC-BY 4.0.
https://physionet.org/content/butppg/2.0.0/

Smartphone camera photoplethysmograms recorded at 30 Hz, each paired with a simultaneous ECG
and an expert quality annotation. Not redistributed in this repository; `validate.py` expects it
under `data/butppg/`.

Of 3,888 records, this project analyses **3,840**. The 48 excluded are legacy records that
encode 300 samples as 300 one-sample signals — a different modality, skipped rather than
silently mangled into a result.

## Why the dataset's own heart-rate column is not used

The corpus ships an `HR` column in `quality-hr-ann.csv`. Pulse scores against heart rates
computed from the ECG's own R-peak annotations over the same window instead.

Measured across all 3,888 records with usable QRS annotations, the shipped column differs from
the R-peak-derived rate by **2.98 bpm mean absolute error** (median 0.79). The largest
disagreements are systematic: for subject 142 the column is roughly double the R-peak rate
across many records — for example record 142036, R-peaks give 72.4 bpm and the column says 159.

Scoring against that column charges the tool for the reference's errors as well as its own.
Reproduce with the QRS comparison in `validate.py`.

## What Pulse measures

Produced by `python validate.py`, which writes `validation.json`.

| | |
|---|---|
| Records analysed | 3,840 |
| Expert annotators call usable | 795 |
| Pulse accepts | 202 (5.3%) |
| Refuses what the annotators refuse | **98.1%** |
| Accepts what the annotators accept | 18.2% |
| Rate within 5 bpm of ECG, on accepted | **85.1%** |
| Within 10 bpm | 87.6% |
| Median absolute error | **0.93 bpm** |
| Mean absolute error | 6.11 bpm |

The mean sits far above the median because a small number of accepted recordings are badly
wrong rather than slightly wrong. That tail is the honest weakness and it is reported next to
the headline rather than trimmed.

## Accuracy is limited by recording length, not by method

Gate held fixed, only the analysis window varied:

| Window | Within 5 bpm of ECG |
|---|---|
| 4 s | 61% |
| 6 s | 74% |
| 8 s | 82% |
| 10 s | 90% |

Every recording in BUT PPG is ten seconds, which is the ceiling of that table. **That the trend
continues past ten seconds is an extrapolation, not a measurement**, and the app says so on its
own limits page.

## Measuring the calmest window rather than the first

Sliding an eight-second window across the recording and measuring the calmest stretch, instead
of the first one:

| | Records accepted | Mean error | Within 5 bpm |
|---|---|---|---|
| First 8 s | 149 | 7.33 bpm | 82% |
| Calmest 8 s | **204** | **6.38 bpm** | 84% |

More records accepted *and* lower error. The window is chosen by signal purity, never by the
rate it produces, so the choice cannot select for a particular answer.

## The browser and the Python agree

`verify_dsp.mjs` runs `ppg.py` and `web/dsp.js` over the same real recordings and compares
every intermediate value. Across **418 traces and 1,570 candidate windows**:

- filtered signal, heart rate, rmssd, sdnn, cv, pnn50 — maximum divergence **exactly 0.0**
- spectral purity — maximum divergence **6.661e-16**
- beat indices, accept/refuse decision, chosen window offset, refusal text — **100% identical**

The one documented non-match is scipy's unstable argsort on exactly equal peak heights, which
did not occur in any of the 1,570 windows and is reproduced deterministically by the JS using a
stable sort.

Each demo recording also ships the values Python produced, and the app displays them beside what
the browser computed, so a judge can see the agreement without running anything.

## What is deliberately not claimed

- **Pulse does not diagnose anything.** It reports a pulse rate and a description of how evenly
  spaced the beats were, or it reports nothing at all.
- **It is not an atrial-fibrillation screen.** The corpus carries no rhythm labels, so the
  irregularity measures are computed and described but never interpreted. Nothing here
  establishes that they detect anything.
- **A refusal is not a finding.** It says the recording could not be measured. It says nothing
  about the person.
- **Nothing is characterised across skin tones**, cold hands, nail polish, or camera hardware.
  BUT PPG is one cohort on a small number of handsets, and PPG is known to behave differently
  across skin tones. This is a real limitation, not a hypothetical one.
- **Accepting 5.3% of the corpus is low.** It is the price of not reporting a wrong rate, and it
  is reported as a headline figure rather than buried.
