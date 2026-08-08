/**
 * VS Code.
 *
 * Unlike the other targets, there is nothing for this CLI to author: the AI First
 * VS Code extension already provides the book browser and a language model
 * provider that serves the same canonical responses. So "installing" here means
 * installing that extension, and the CLI stays out of the way.
 */

import { EXTENSION_ID } from "../constants";
import type { Agent, Detection, InstallResult, PermissionResult, PermissionState, SkillState } from "./types";
import { captureVersion, run, which } from "./util";

/** Editors that ship a `code`-compatible CLI, in preference order. */
const CANDIDATES = ["code", "code-insiders", "codium", "cursor"];

function findEditor(): { bin: string; name: string } | undefined {
  for (const name of CANDIDATES) {
    const bin = which(name);
    if (bin) return { bin, name };
  }
  return undefined;
}

async function installedExtensions(bin: string): Promise<string[]> {
  const result = await run(bin, ["--list-extensions"], 30_000);
  if (!result.ok) return [];
  return result.output.split("\n").map((l) => l.trim().toLowerCase()).filter(Boolean);
}

export const vscodeAgent: Agent = {
  key: "vscode",
  label: "VS Code",
  target: `extension ${EXTENSION_ID}`,

  async detect(): Promise<Detection> {
    const editor = findEditor();
    if (!editor) return { installed: false };
    return { installed: true, version: await captureVersion(editor.bin), via: editor.bin };
  },

  async install(): Promise<InstallResult> {
    const editor = findEditor();
    if (!editor) {
      return { written: [], notes: ["VS Code CLI not found; skipped."] };
    }

    const already = await installedExtensions(editor.bin);
    if (already.includes(EXTENSION_ID.toLowerCase())) {
      return { written: [], notes: [`${EXTENSION_ID} already installed.`] };
    }

    const result = await run(editor.bin, ["--install-extension", EXTENSION_ID], 120_000);
    return {
      written: [],
      notes: [
        result.ok
          ? `Installed ${EXTENSION_ID} via ${editor.name}.`
          : `Could not install ${EXTENSION_ID}: ${result.output.split("\n")[0] ?? "unknown error"}`,
      ],
    };
  },

  async check(): Promise<SkillState> {
    const editor = findEditor();
    if (!editor) return { state: "missing" };
    const present = (await installedExtensions(editor.bin)).includes(EXTENSION_ID.toLowerCase());
    // The extension carries its own version and updates through the Marketplace,
    // so there is no drift for this CLI to police — it's either there or it isn't.
    return present ? { state: "current", version: "marketplace" } : { state: "missing" };
  },

  async remove(): Promise<string[]> {
    const editor = findEditor();
    if (editor) await run(editor.bin, ["--uninstall-extension", EXTENSION_ID], 120_000);
    return [];
  },

  // The extension serves book content inside the editor and never shells out to
  // this CLI, so there is nothing to pre-approve.
  async grantPermissions(): Promise<PermissionResult> {
    return { state: "unsupported", changed: [] };
  },
  async permissionState(): Promise<PermissionState> {
    return "unsupported";
  },
  async revokePermissions(): Promise<string[]> {
    return [];
  },
};
