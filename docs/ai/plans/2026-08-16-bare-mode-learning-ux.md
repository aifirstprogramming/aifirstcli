---
feature_id: bare-mode-learning-ux
date: 2026-08-16
shipped: true
---

# Bare-Mode Learning UX Fixes

I implemented the approved plan to make `aifirst learn` reproduce the proven installed-skill workflow: `next` gives Claude a complete exercise/code instruction, Claude writes and executes the code, explains it, and successful execution advances the learner.

The target workflow is the installed-skill workflow: `aifirst next` presents the exercise and the exact code/instruction to type or copy. Claude Code submits it; the CLI writes, executes, explains, records success, and advances. `aifirst show <id>` is read-only and must not claim file creation or progress advancement. `aifirst run <id>` is the explicit direct write/execute/record path.

I verified the implementation against the reference scenarios across Python, Java, success, failure, show-only, multi-step, and advancement conditions. The CLI/server/skill boundary now returns canonical code and a complete safe action from `next`, while `show` stays read-only and `run` is the verified write/execute/record path. Content-library code and explanations remain authoritative and JSON stable.

All tests pass and the CLI behaviors match the spec exactly.
