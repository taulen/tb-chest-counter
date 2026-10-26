# Wedged-browser liveness

A scan on 2026-08-04 ran 4h59m37s (58 batches at ~310s against a healthy ~4s), blocked both clans behind the scan-in-progress guard, and had to be killed by hand. The host — not this container, whose cgroup sat at 914MB of a 5120MB ceiling — was out of memory and the kernel was OOM-killing Chromium's children. **`memory.events`' `oom_kill` counts kills by ANY OOM killer, so a rising count next to a healthy `memory.current` means the LXC is starved, not the container.** Raising `MEMORY_LIMIT` cannot help that.

Three bounds keep it from recurring, and they are layered on purpose:

- **Per-call deadlines** (`input.ts`) catch a call that never returns. Necessary, but a browser answering everything 80× slow violates no per-call deadline.
- **A throughput guard** in [scan-pipeline.ts](../src/scheduler/scan-pipeline.ts) — 3 consecutive batches over 60s, a 45-min capture budget, or any `oom_kill` during the sweep — abandons the capture phase. This is what actually caught the incident's failure mode.
- **The OCR phase is deliberately exempt** from both. Its crops represent chests already *claimed* in-game, so abandoning one is unrecoverable loss where abandoning a capture batch only postpones chests still sitting on the Gifts tab. It also touches no browser.

**Do not "fix" the missing OCR timeout.** `onnxruntime-node`'s `run()` is a synchronous native call behind a cosmetic `setImmediate`, so it holds the event loop for its whole duration — which is also why the admin UI goes dead during a scan rather than reporting a stuck one. A `Promise.race` around it can never fire: the timer cannot run while the thread is inside the inference. Measuring the batch afterwards is the only bound available short of moving OCR to a worker thread.
