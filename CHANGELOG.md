# Changelog

## 1.6.0

Ports the four checks from the earlier v1.1.0 branch onto this codebase (VPAT Matrix / Pulse / Audit Tools rename baseline), and wires them into the VPAT criteria table properly instead of leaving them as orphaned findings. Also fixes a mislabeled criterion found while doing that wiring.

### New checks

- **Live region audit** (new Audit Tools entry: *Watch Live Regions*). Attaches a `MutationObserver` to every `aria-live`/`role="status"|"alert"|"log"` element and watches for actual updates, alongside a static scan flagging any region that already contained text at scan time. Registered against **4.1.3 Status Messages** — re-pointed that criterion's "Test this" link from the ARIA Inspector to this tool, since the ARIA Inspector can only see that `aria-live` exists, not whether it ever actually fires.
- **Focus indicator check** (new Audit Tools entry: *Check Focus Indicators*). Walks every focusable element, focuses it, and diffs computed style before/after to flag anything with no detectable visual change. Registered against **2.4.7 Focus Visible** — re-pointed from the Tab Order tool, which shows focus *order* but never checked whether an indicator is actually visible.
- **`role="application"` review** (feeds the existing Needs Review queue, registered as an `axeRules` entry against **2.1.1 Keyboard**). The role hands all arrow-key/Escape handling to page JavaScript, disabling normal screen-reader text review for that region — correct on a canvas editor, silently broken on static text. Always flagged for manual verification.
- **Drag interaction review** (feeds Needs Review, registered against **2.5.7 Dragging Movements** — which previously had zero automated evidence of any kind). Heuristic detection of `draggable="true"` and known drag-and-drop libraries (Sortable.js, react-beautiful-dnd, dnd-kit, interact.js, jQuery UI).

### Bug fix: mislabeled VPAT criterion

The existing row for **`2.4.11`** was named "Focus Appearance" with a test method describing indicator thickness and 3:1 contrast — that's actually the substance of **2.4.13 Focus Appearance (AAA)**, not 2.4.11. The real AA-level 2.4.11 is **Focus Not Obscured (Minimum)**: whether the focused element is entirely hidden behind sticky headers/footers/banners, which is a different check entirely. Renamed the row and rewrote its test method to match the actual criterion. (2.4.13 itself is AAA and stays out of scope, consistent with this tool's existing A/AA-only criteria list and ACR export filter.)

### Why these four (and the fix)

All of it came out of a documentation review cross-referencing JAWS's keystroke references, ARIA support notes, and UIA Script API against the NVDA 2026.1.1 user guide and WCAG 2.2. Two findings drove this work directly: axe-core is a static DOM snapshot and structurally cannot see anything that only exists *in time* (a live region that never fires, a focus style that never changes) — and no screen reader test, JAWS or NVDA, can ever verify focus visibility either, since AT announces "focused" whether or not a human can see it.

### Notes for whoever picks this up next

- No new manifest permissions required.
- Written and carefully reviewed, but not run inside an actual loaded Chrome extension in this environment — no live browser test harness was available. Load it unpacked and run it against a real page with a live region and a couple of focus-style patterns (including one with `outline: none` and no replacement) before shipping.
- `resetToolState()` now tears down the live-region `MutationObserver` on "New Test." If another watcher-style tool gets added later, give it the same cleanup treatment or it'll keep observing a stale page.
- The two new synthetic incomplete entries (`role-application-review`, `drag-interaction-review`) only ever appear in `results.incomplete`, never in `passes` — their absence on a page that has no `role="application"` or drag interaction correctly leaves those VPAT rows unaffected (`Not Evaluated` unless another axe rule or manual verdict says otherwise), not silently marked "clean."
