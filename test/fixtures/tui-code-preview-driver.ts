import { LearnTuiSession } from "../../src/tui/session";

const session = await LearnTuiSession.create("Code preview test");
try {
  const source = Array.from({ length: 75 }, (_, index) => `print("line ${index + 1}")`).join("\n");
  session.appendCode("demo.py", "python", source, 40);
  await Bun.sleep(750);
  await session.choose("Finished expanding?", [{ key: "done", label: "Done" }]);
} finally {
  await session.destroy();
}
