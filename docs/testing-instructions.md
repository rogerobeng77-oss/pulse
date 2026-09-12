No sign-up. No credentials. Nothing is uploaded — everything runs in your browser.

Open https://d1kvjmmokxigdv.cloudfront.net

**Four real recordings**, each from BUT PPG with a simultaneous ECG, chosen to
show both answers the tool can give.

**Clean recording (149030).** Accepted. 82.9 bpm against an ECG truth of 82.1.
Look at the chart: the shaded band is the eight seconds it actually measured,
and it excludes the last second and a half where the trace goes erratic.

**Caught by the cross-check (119081).** Refused, and this is the one to spend
time on. Beat-counting said 45 bpm; the spectrum said 38. They disagreed, so
nothing is reported. The ECG truth is 67. Had the tool answered, it would have
been wrong by 22 bpm. You can see the skipped beats in the waveform.

**Refused for movement (112002).** No single dominant pulse frequency. The four
checks are listed with the first failure marked, so the refusal has a reason
rather than a shrug.

**Python vs this browser.** Every sample shows both, side by side: accept
decision, heart rate, signal purity. All three match on all four recordings.

**Your own camera** — needs a rear camera and a flash. Cover both completely
with a fingertip and hold still. It records thirty seconds. Expect it to refuse
if you move: on the validation corpus it accepts 5.3% of recordings, which is
the price of not reporting a wrong number.

**Evidence** and **Limits** in the top nav carry the full validation and the
things this does not do — including that it is not an atrial fibrillation
screen, because the corpus has no rhythm labels.

To reproduce: `python validate.py` in the repository root, and `node verify_dsp.mjs` to
check the browser and the Python agree. Needs BUT PPG from PhysioNet under
`data/` — not redistributed here.
