import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import diff from "highlight.js/lib/languages/diff";
import java from "highlight.js/lib/languages/java";
import json from "highlight.js/lib/languages/json";
import python from "highlight.js/lib/languages/python";
import xml from "highlight.js/lib/languages/xml";
import { getTreeSitterClient, type SimpleHighlight, type TreeSitterClient } from "@opentui/core";

hljs.registerLanguage("bash", bash);
hljs.registerLanguage("diff", diff);
hljs.registerLanguage("java", java);
hljs.registerLanguage("json", json);
hljs.registerLanguage("python", python);
hljs.registerLanguage("xml", xml);

const LANGUAGE_ALIASES: Record<string, string> = {
  bash: "bash",
  diff: "diff",
  html: "xml",
  java: "java",
  json: "json",
  maven: "xml",
  patch: "diff",
  py: "python",
  python: "python",
  python3: "python",
  sh: "bash",
  shell: "bash",
  xml: "xml",
  zsh: "bash",
};

const CLASS_GROUPS: Record<string, string> = {
  "hljs-attr": "property",
  "hljs-built_in": "function.builtin",
  "hljs-bullet": "punctuation.special",
  "hljs-comment": "comment",
  "hljs-doctag": "comment",
  "hljs-keyword": "keyword",
  "hljs-literal": "constant.builtin",
  "hljs-meta": "keyword",
  "hljs-number": "number",
  "hljs-params": "variable",
  "hljs-property": "property",
  "hljs-punctuation": "operator",
  "hljs-section": "function",
  "hljs-string": "string",
  "hljs-symbol": "constant",
  "hljs-tag": "tag.punctuation",
  "hljs-name": "tag",
  "hljs-title": "function",
  "hljs-type": "type",
  "hljs-variable": "variable",
  class_: "type",
  function_: "function",
};

function decodeHtml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Convert highlight.js spans into the semantic offsets OpenTUI expects. */
export function syntaxHighlights(content: string, filetype: string): SimpleHighlight[] {
  const requested = filetype.toLowerCase();
  const language = LANGUAGE_ALIASES[requested] ?? requested;
  if (!hljs.getLanguage(language)) return [];

  const html = hljs.highlight(content, { language, ignoreIllegals: true }).value;
  const parts = html.split(/(<span class="[^"]+">|<\/span>)/g).filter(Boolean);
  const groups: Array<string | undefined> = [];
  const highlights: SimpleHighlight[] = [];
  let offset = 0;

  for (const part of parts) {
    if (part === "</span>") {
      groups.pop();
      continue;
    }
    const opening = /^<span class="([^"]+)">$/.exec(part);
    if (opening) {
      const names = opening[1].split(/\s+/);
      groups.push(names.reverse().map((name) => CLASS_GROUPS[name]).find(Boolean));
      continue;
    }

    const text = decodeHtml(part);
    const group = [...groups].reverse().find(Boolean);
    if (group && text.length > 0) highlights.push([offset, offset + text.length, group]);
    offset += text.length;
  }

  if (requested === "maven") {
    for (const match of content.matchAll(/\$\{[^}\n]+\}/g)) {
      if (match.index !== undefined) highlights.push([match.index, match.index + match[0].length, "maven.property"]);
    }
    for (const match of content.matchAll(/<(groupId|artifactId|version|scope|mainClass|packaging|module)>([^<\n]+)<\/\1>/g)) {
      if (match.index === undefined || match[2] === undefined) continue;
      const start = match.index + match[0].indexOf(match[2]);
      highlights.push([start, start + match[2].length, "maven.coordinate"]);
    }
  }
  return highlights;
}

/** CodeRenderable only needs highlightOnce; avoiding parser assets keeps binaries portable. */
export const tuiHighlightClient = {
  async highlightOnce(content: string, filetype: string) {
    const language = LANGUAGE_ALIASES[filetype.toLowerCase()] ?? filetype.toLowerCase();
    if (hljs.getLanguage(language)) return { highlights: syntaxHighlights(content, filetype) };
    return getTreeSitterClient().highlightOnce(content, filetype);
  },
} as TreeSitterClient;
