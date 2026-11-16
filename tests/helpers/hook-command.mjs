/** Expected native command, independent of the production command builder. */
export function expectedHookCommand(target, role) {
  return process.platform === "win32"
    ? `node "${target.replace(/\\/g, "/")}" ${role}`
    : `'${target.replace(/'/g, "'\\''")}' ${role}`;
}
