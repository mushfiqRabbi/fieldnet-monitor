# AI use

* **Tools:** Claude Code. I used it to read the brief closely, draft the design
  (`docs/DESIGN.md`), write most of the code and tests from that design, and run the review
  loop. I reviewed every file against the brief, ran the tests and the simulator myself, and
  checked the console in a real browser.
* **What it got wrong that I caught:** it saved a sensor replay with the `now` it was given. A
  background item runs at its due time, which can be a moment *before* a request already replayed
  the same sensor. Replaying to that earlier time gives a shorter history, and the diff then
  records a false `correction`. I added `computed_at`, so a replay never goes back in time
  (`domain/sensorStore.ts`).
* **Also caught:** the 24-hour "latest collection" window excluded an outcome at exactly 24h.
  A gateway that reports at the same minute every day then flickered to `not_checked` for an
  instant, and wrote two timeline entries a day. The window now includes exactly 24h.
