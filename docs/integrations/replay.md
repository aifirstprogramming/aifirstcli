# Claude Code replay

Published AI First exercises can include a deterministic Claude Code replay in the content pack. Replay is part of the normal prompt flow; learners do not enter a separate replay mode.

## Normal use

Install the Claude Code skill or start local learning:

```text
aifirst skill install --claude
aifirst learn
```

For a disposable local session that wires Claude Code directly to the native
replay server, use:

```text
aifirst claude
```

This preserves Claude Code's normal tool UI while keeping replay responses local.
In a non-interactive container, pass Claude Code's permission bypass flag only
when the workspace is disposable:

```text
aifirst claude -- --dangerously-skip-permissions
```

Entering an exercise's exact first prompt starts its replay automatically. The replay presents the captured commentary, writes or updates recorded files, executes recorded commands, and checks captured exit codes and output. Published content is trusted and runs directly in the current workspace.

A close but non-exact match never runs immediately. Claude asks for confirmation; replying `yes` runs that one pending replay and replying `no` cancels it. Pending confirmation is scoped to the workspace and expires after 30 minutes.

The Claude Code `UserPromptSubmit` hook performs replay in normal skill mode. In `aifirst learn`, the hook only supplies context and the local responder performs the same operations, preventing duplicate execution.

For workflow replays, the hook keeps planning context compact and supplies one
trusted post-approval command: `aifirst replay execute <id> --format json`.
`aifirst init` allowlists that exact command prefix, so Claude does not need to
inspect its hook-result file with `wc`, `awk`, `sed`, or Python, and the learner
does not receive approval prompts for replay plumbing.

### Planning workflows

A replay may require an approved plan before any operation runs. Normal skill
mode asks Claude to enter native plan mode, presents the authored question groups,
and lets the model design a verified variant when the learner chooses a
non-book answer. In normal skill mode the book choice is first and receives
Claude's single normal **Recommended** label. Local learning labels the same
choice **Book Recommended** because no model is choosing the recommendation.

`aifirst learn` follows the same questionnaire without a model. Canonical and
fully authored variant paths can continue to plan approval. An unsupported
choice explains that an LLM is required and offers to use the book answer,
restart planning, or leave local learning. It never silently substitutes the
book answer, and no mutating operation is emitted before approval; captured
read-only inspection may run first when the original session did so.

Verified LLM-generated alternatives are recorded as variants with stable
question and option ids. Free-form learner text and generated plans are not
stored in the progress log.

Local learning paces cached text so commentary and plans remain readable before
their corresponding native tool call appears. The default is 360 characters per
second and can be overridden with `AIFIRST_LEARN_CHARS_PER_SECOND`; `0` restores
instant output. Skill mode and the direct replay server are not paced.

## Content format

Replay metadata is authored inline on a single exercise or progressive prompt step in `aifirstcontent`:

```json
{
  "prompt": "Write a Hello World app",
  "events": [
    { "type": "text", "text": "I’ll create the program and run it." },
    { "type": "operation", "operation": { "type": "write", "path": "hello_world.py", "content": "print(\"Hello, World!\")\n" } },
    { "type": "operation", "operation": { "type": "command", "command": ["python3", "hello_world.py"], "expectedStdout": "Hello, World!\n" } }
  ],
  "completionText": "The program is complete and prints Hello, World!"
}
```

Ordered `events` preserve standalone commentary and status text around native
`write`, `edit`, `read`, and `command` operations. Legacy parallel
`operations`/`commentary` metadata remains supported for older content.
Workflow replays may also use `prePlanEvents`; validation permits only reads and
commands explicitly marked `readOnly` there.

Workflow-enabled replays additionally carry `workflow.questions`,
`canonicalAnswers`, `canonicalPlan`, and optional deterministic `variants`.
Questions may use `when` conditions to depend on earlier answers and `group` to
place adjacent questions in one native dialog. `workflow.interludes` preserve
captured read-only checks that occurred after a question group but before plan
approval, such as dependency probes or layout validation.

Write paths and command working directories must stay inside the workspace. Commands may include `cwd`, `env`, `stdin`, `expectedExitCode`, `expectedStdout`, and `expectedStderr`.

## Showtail authoring tools

The explicit `aifirst replay` commands remain compatibility and authoring tools, not the learner-facing flow:

```text
aifirst replay import report.json --name demo
aifirst replay list
aifirst replay show demo
aifirst replay reset demo
aifirst replay run demo --mode skill
aifirst replay run demo --mode learn
```

Import always prints a privacy warning because reports can contain real prompts, files, and tool output. Existing names are protected unless `--force` is supplied. Reports that include canonical `operations` on a turn preserve them as executable replay metadata; older reports remain display-only because diffs and tool output alone cannot safely reconstruct filesystem changes or commands.
