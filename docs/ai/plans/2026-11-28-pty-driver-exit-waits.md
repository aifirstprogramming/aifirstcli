# Decision note: check remaining PTY waits when the child exits

- Date: 2026-11-28
- Scope: Test fixtures on `release/v0.13.2`. No product or workflow changes.
- Status: Proposed in a separate PR. Closes the open point in the
  [OSC stripping note](2026-11-26-osc-stripping-and-keypress-test.md).

This is a decision note written after implementation, not a verbatim plan.

One full local check failed "lets a terminal reader answer an interactive
exercise" with 2 of 3 driver actions completed, although the captured output
held the last marker. `test/fixtures/native-tui-driver.py` handled one action
per loop pass and stopped as soon as a read reached the child's exit. When a
program's last lines arrived together with its exit, the final wait was never
checked against output the driver already had.

After the child exits, the driver now keeps checking the remaining waits
against the captured output. It stops at the first wait that output does not
satisfy, and at any action that would need to send input, since nothing can
reach the child then. A missing marker still fails at once rather than waiting
for the deadline. No retries or longer timeouts were added.

Two tests in `test/tui-driver-matching.test.ts` use a fixture that prints two
markers in one write and exits at once:

- Both waits must pass. Before the fix this failed in 3 of 3 runs with
  `completedActions 1/2`, pending the second marker.
- A marker the program never prints must still fail, with exit status 2, well
  before the deadline. This passed before and after the fix.

Observed on Linux: the driver tests pass, typecheck passes, the interactive
`run` test passed 20 of 20 isolated runs, and the full local check had 592
passes and only the two environment-dependent failures (the `.claude` in
`PATH` session test and the 256-color syntax test). Hosted CI on the PR is the
macOS check.
