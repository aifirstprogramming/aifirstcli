import type { Args } from "../cli";
import { formatFlag } from "../cli";
import { resolveContent } from "../content";
import { bold, dim, glyph, green, json, out } from "../output";
import { resolveWorkspace } from "../workspace";

export function workspace(args: Args): void {
  const format = formatFlag(args, ["text", "json"]);
  const { content } = resolveContent();
  const resolved = resolveWorkspace(content, args.positionals[0]);
  if (format === "json") {
    json({
      key: resolved.key,
      path: resolved.path,
      book: resolved.book ? { id: resolved.book.id, tag: resolved.book.tag, title: resolved.book.title } : null,
    });
    return;
  }
  out();
  out(`  ${green(glyph.done)} workspace ${bold(resolved.path)}`);
  if (resolved.book) out(dim(`  ${resolved.book.title}`));
  out();
}
