---
feature_id: local-claude-wrapper-and-reader-output
date: 2026-08-13
shipped: true
---

# Local Claude wrapper verification rework

The verifier found that the temporary Claude child environment used the wrong
credential variable and did not mark local demo mode. It also found that the
native release gate named by the feature was not represented by a checked-in
harness and platform matrix.

I verified the current launch path instead of assuming the environment contract:
`claudeLaunch` now emits only the synthetic child token under
`ANTHROPIC_AUTH_TOKEN`, sets `IS_DEMO=1`, keeps the loopback URL dynamic, and
continues to omit the normal profile environment. The independent contract test
checks both values and confirms that the session record never contains the token.

I chose a small controlled harness and a separate native verification document.
The harness uses a fake client for deterministic local checks, while the
platform matrix explicitly requires real Claude Code binaries on Linux, macOS,
and Windows before release claims. This keeps fake-client evidence useful
without treating the previously timed-out native Linux attempt as success.

The focused verifier test and the repository checks are the evidence for this
rework. Native platform evidence remains an operational release gate, not an
assertion made by the source tree.
