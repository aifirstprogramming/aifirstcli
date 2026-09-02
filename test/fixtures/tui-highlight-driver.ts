import { currentTuiSession, withTuiSession } from "../../src/tui/session";

await withTuiSession(async () => {
  const session = currentTuiSession();
  if (!session) throw new Error("TUI session did not start");
  await session.appendMarkdown("## Python\n\n```python\nfrom pathlib import Path\nprint(\"duck\")\n```\n", { noAnimation: true });
  session.appendDiff(
    "main.py",
    'def greet():\n    return "hello"\n',
    'def greet():\n    return "hello, duck"\n',
  );
  await session.appendMarkdown(
    '## Maven\n\n```maven\n<project><groupId>com.example</groupId><version>${project.version}</version></project>\n```\n',
    { noAnimation: true },
  );
  session.appendDiff(
    "pom.xml",
    "<project><version>1.0.0</version></project>\n",
    "<project><version>${project.version}</version></project>\n",
  );
  await Bun.sleep(300);
  session.appendText("HIGHLIGHT_DONE");
  await Bun.sleep(100);
}, "AI First Highlight Test");
