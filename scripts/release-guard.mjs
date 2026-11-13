import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

function validateBaseline(registry, previous) {
  assert.equal(registry["dist-tags"]?.latest, previous,
    "npm latest and the previous release tag disagree; reconcile before releasing");
  assert.ok(registry.versions?.[previous], "Previous release is missing from npm");
}

export function validateRegistry(registry, previous, next) {
  validateBaseline(registry, previous);
  assert.ok(!Object.hasOwn(registry.versions, next), "This version is already published");
  assert.match(next, /^\d+\.\d+\.\d+$/, "Only stable versions may publish to latest");
  const oldParts = previous.split(".").map(Number);
  const newParts = next.split(".").map(Number);
  const changed = newParts.findIndex((part, i) => part !== oldParts[i]);
  assert.ok(changed >= 0 && newParts[changed] > oldParts[changed],
    "Refusing to move npm latest backwards");
}

export function validatePackage(pkg, lock, version) {
  assert.equal(pkg.name, "midbrain-memory-mcp");
  assert.equal(pkg.version, version, "Source version disagrees with release version");
  assert.equal(lock.version, version, "Lockfile version disagrees with release version");
  assert.equal(lock.packages?.[""]?.version, version, "Lockfile root version disagrees");
}

async function readRegistry() {
  const response = await fetch("https://registry.npmjs.org/midbrain-memory-mcp/", {
    signal: AbortSignal.timeout(30_000),
  });
  assert.ok(response.ok, `Cannot verify npm release state: HTTP ${response.status}`);
  return response.json();
}

export async function verifyConditions(_config, { branch }) {
  const versions = branch.tags.map(tag => tag.version)
    .filter(version => /^\d+\.\d+\.\d+$/.test(version));
  versions.sort((a, b) => {
    const left = a.split(".").map(Number);
    const right = b.split(".").map(Number);
    return right[0] - left[0] || right[1] - left[1] || right[2] - left[2];
  });
  assert.ok(versions.length, "No release baseline tag found");
  // This stage also runs when there are no new commits. A failed upload must
  // not turn into a misleading successful no-op on the next workflow run.
  validateBaseline(await readRegistry(), versions[0]);
}

export async function verifyRelease(_config, { lastRelease, nextRelease }) {
  validateRegistry(await readRegistry(), lastRelease.version, nextRelease.version);
}

export function validateTarball(result, version) {
  // npm 11 keys publish results by package name; npm 10 returns the package.
  const pack = result["midbrain-memory-mcp"] ?? result;
  assert.equal(pack.name, "midbrain-memory-mcp");
  assert.equal(pack.version, version, "Packed version disagrees with release version");
  const paths = pack.files.map(file => file.path);
  for (const required of ["index.js", "install.mjs", "mcp.mjs", "dist/midbrain-shared.mjs"]) {
    assert.ok(paths.includes(required), `Package is missing ${required}`);
  }
  assert.ok(!paths.some(path => /(^|\/)(\.midbrain-key|\.midbrain-keystore\.json|\.env)(\.|$)/.test(path)),
    "Credential file found in package");
}

// Runs after @semantic-release/npm has updated versions,
// but before @semantic-release/git commits and semantic-release pushes the tag.
export function prepare(_config, { nextRelease }) {
  const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
  validatePackage(readJson("package.json"), readJson("package-lock.json"), nextRelease.version);
  const packed = execFileSync("npm", ["publish", "--dry-run", "--json", "--access", "public"], {
    encoding: "utf8", stdio: ["ignore", "pipe", "inherit"],
  });
  validateTarball(JSON.parse(packed), nextRelease.version);
  process.stdout.write(packed);
}
