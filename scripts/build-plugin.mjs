import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await fs.readFile(path.join(repoRoot, "package.json"), "utf8"));

await build({
  entryPoints: [path.join(repoRoot, "shared", "plugin-entry.mjs")],
  bundle: true,
  format: "esm",
  platform: "node",
  external: ["jsonc-parser", "smol-toml", "yaml"],
  outfile: path.join(repoRoot, "dist", "midbrain-shared.mjs"),
  define: {
    __MIDBRAIN_PACKAGE_NAME__: JSON.stringify(packageJson.name),
    __MIDBRAIN_PACKAGE_VERSION__: JSON.stringify(packageJson.version),
  },
});
