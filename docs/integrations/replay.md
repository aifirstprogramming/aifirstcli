# Showtail replay

AI First can import a Showtail JSON report and play it back through the local Anthropic-compatible server. Replay uses the captured commentary, diffs, and tool output, so it does not execute the recorded commands or call a model.

## Import and inspect

```text
aifirst replay import report.json --name demo
aifirst replay list
aifirst replay show demo
aifirst replay reset demo
```

Import prints a privacy warning because a report can contain real prompts, files, and tool output. The warning cannot be disabled. Existing names are protected unless `--force` is supplied.

## Use a replay

Start the local server with `aifirst serve --replay demo`. In another terminal, run `aifirst book-mode on --replay demo` for a full Claude Code session, or run `aifirst learn --replay demo` for the isolated bare session. Each request advances the pack and stores its position under the state directory with restrictive file permissions.

Replay is static and instant by design. A future `--verify-last-run` option may re-check a final step live, but it is not part of this version.