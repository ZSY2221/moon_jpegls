# Cancellation and replacement jobs

On Node 24.20.0 before the fix, the supplied `--expect-bug` probe returned 0 and displayed original and reconstructed pixel 2000 after the replacement job had started. The same probe in default mode returned 1. It imported the real application modules with a simulated worker and DOM. Its original SHA-256 is `b33692f2faff918c75af3ff9ae79fcdc1854db0212a7952da07c433dd99f5822`.

After the fix, the default gate returned 0 with both pixel values 4000. The `--expect-bug` gate returned 1. The app invalidates the cancelled job immediately and guards continuations after asynchronous host calls. A cancelled job can still finish an in-flight host operation, but its result cannot advance the preview, statistics, sink, download or replacement job's cleanup.

The real Chrome 158.0.8127.37 run used a module Worker and the built MoonBit codec. It cancelled and immediately restarted while the old task was waiting on a delayed original-row read or writer call. In both cases the new job displayed 4000 and its downloaded stream decoded to `[3000, 3000, 4000, 4000]`. The writer case made one old write, one abort and zero closes. The writer was controllably simulated in the real browser so the test does not exercise a native file-picker dialog.

```sh
node REVIEW_EVIDENCE/web_cancel_probe.mjs .
node sdk/build.mjs
node web/build.mjs
# Start the local static server per web/README.md, then run:
npm --prefix web run smoke
```
