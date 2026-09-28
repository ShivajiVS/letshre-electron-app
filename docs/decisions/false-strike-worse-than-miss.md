# A false strike is worse than a missed one

**Decision:** when the app isn't sure, it reports less, or reports it as something the site can weigh, rather than something that ends the interview.

**Why:** a false termination costs a real candidate their attempt and there's no appeal in the moment. A missed signal is usually caught again seconds later, by another check, or in the recording.

**What it means in code:**

- Extra displays are strikes on the site's limit, never hard blocks, and are re-sent every 15s so a held one still adds up (`STRIKE_CODES` in `src/shared/violationCodes.js`).
- Overlays count only after 5s visible, and known laptop pop-up utilities are trusted from their install folder (`OVERLAY_TRUSTED_LOCATIONS` in `agent.py`). An overlay is medium: it warns first.
- `focus_lost` and `virtual_desktop` are site-decides: the app pulls the window back, the site's own focus tracking already strikes.
- A security-check card only turns green after two clean reads, and a flow-guard block only clears after two clean ticks, so a flicker doesn't bounce the candidate (`GUARD_CLEAR_TICKS`).
- Redeliveries keep their `id`, so a resend can't count twice.

This sits beside [fail-closed](fail-closed.md), not against it: an unanswerable check blocks, but a doubtful finding doesn't end the interview.
