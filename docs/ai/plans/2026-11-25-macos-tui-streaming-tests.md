# Decision note: stabilize the macOS TUI streaming tests

- Approved: 2026-11-25
- Scope: Test fixtures on `release/v0.13.2`. No product or workflow changes.
- Status: Proposed in a separate PR from the JavaFX fix (#26).

Both macOS attempts on #26 timed out at the same points. The mouse test
waited for `Builda` in a stream of terminal updates. Depending on how the
renderer paints the cursor, those letters do not arrive together. The plan
test waited for the body marker after the picker, but the marker had
already appeared in the terminal output before the picker.

Wait for the footer that advertises the reveal action. Hold the animation
through the fixture's existing `sleep` option so the click or key must
actually release it. The PTY driver waits for both the complete-plan marker
and the picker before sending Enter, without requiring a particular paint
order. Before sending the reveal key, it checks that the plan marker is
absent from both captured and queued output. The tests still use the real
TUI, mouse input, and keyboard input.
There are no additional retries or longer timeouts.

With Bun 1.4.0 on Linux, both focused tests pass. Removing the click or the
ordinary key makes the PTY driver time out at the corresponding next
state. The full local check went from five failures to four, removing the
mouse test failure without adding any new failing tests. A synthetic PTY
probe confirmed both paint orders work. A driver test covers a forbidden
marker already in the capture or queued during the action's settle delay.
Hosted macOS CI is the cross-platform acceptance check.
