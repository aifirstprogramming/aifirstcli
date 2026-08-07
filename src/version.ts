import pkg from "../package.json";

/** CLI version, single-sourced from package.json and bundled at build time. */
export const VERSION: string = pkg.version;

/** Where the book tells readers to install from. */
export const INSTALL_HOST = "https://aifirstprogramming.com";
export const INSTALL_COMMAND = `curl -fsSL ${INSTALL_HOST}/install.sh | bash`;

/** Release artifacts, used by `aifirst update`. */
export const REPO = "aifirstprogramming/aifirstcli";
export const CONTENT_REPO = "aifirstprogramming/aifirstcontent";
