/**
 * Secret-free diagnostics helpers shared by the MCP diagnostics tool.
 */

import os from "os";
import path from "path";

/**
 * Render paths under the user's home with a leading `~` and portable
 * separators. Non-path source labels and paths outside home are unchanged.
 *
 * @param {string} value
 * @param {string} [homeDir]
 * @param {NodeJS.Platform} [platform]
 * @returns {string}
 */
export function homeRelativePath(
  value,
  homeDir = os.homedir(),
  platform = process.platform,
) {
  if (typeof value !== "string" || !value || /^(?:env:[A-Z0-9_]+|default)$/.test(value)) {
    return value;
  }
  const paths = platform === "win32" ? path.win32 : path.posix;
  if (!paths.isAbsolute(value) || !paths.isAbsolute(homeDir)) return value;
  const relative = paths.relative(homeDir, value);
  if (relative === "") return "~";
  if (relative === ".." || relative.startsWith(`..${paths.sep}`) || paths.isAbsolute(relative)) {
    return value;
  }
  return `~/${relative.replaceAll("\\", "/")}`;
}
