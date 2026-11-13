import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeCommits } from "@semantic-release/commit-analyzer";
import releaseConfig from "../release.config.mjs";

const BOOTSTRAP_SHA = "b09f9f6ce0e9eb19655d1062c8db92f7c079a8ad";
const logger = { log() {} };

function compareVersions(a, b) {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  return right[0] - left[0] || right[1] - left[1] || right[2] - left[2];
}

export function selectBaseline(tags) {
  const [prefix, suffix] = releaseConfig.tagFormat.split("${version}");
  const releases = tags.flatMap(tag => {
    if (!tag.startsWith(prefix) || !tag.endsWith(suffix)) return [];
    const version = tag.slice(prefix.length, suffix ? -suffix.length : undefined);
    return /^\d+\.\d+\.\d+$/.test(version) ? [{ tag, version }] : [];
  }).sort((a, b) => compareVersions(a.version, b.version));
  if (releases.length) return releases[0];
  assert.ok(tags.includes("v0.4.10"), "Missing v0.4.10 baseline; run git fetch origin --tags first");
  return { tag: "v0.4.10", version: "0.4.10" };
}

export async function previewCommits(baseline, commits) {
  const analyzer = releaseConfig.plugins.find(plugin =>
    (Array.isArray(plugin) ? plugin[0] : plugin) === "@semantic-release/commit-analyzer");
  assert.ok(analyzer, "Release commit analyzer changed; update the preview command");
  const options = Array.isArray(analyzer) ? analyzer[1] : {};
  // Match semantic-release's preprocessing, including its skip-release markers.
  const included = commits.filter(commit => !/\[skip\s+release]|\[release\s+skip]/i.test(commit.message));
  const type = await analyzeCommits(options, { cwd: process.cwd(), commits: included, logger });
  if (!type) return { baseline, type: null, version: null };
  assert.ok(["major", "minor", "patch"].includes(type), `Unsupported release type: ${type}`);
  const parts = baseline.version.split(".").map(Number);
  const index = { major: 0, minor: 1, patch: 2 }[type];
  parts[index] += 1;
  for (let i = index + 1; i < parts.length; i++) parts[i] = 0;
  return { baseline, type, version: parts.join(".") };
}

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function requireAncestor(ref) {
  try {
    git("merge-base", "--is-ancestor", ref, "HEAD");
  } catch {
    throw new Error(`${ref} is not contained in HEAD; merge release back into this branch before previewing`);
  }
}

async function main() {
  const baseline = selectBaseline(git("tag", "--list").split("\n"));
  const sha = git("rev-parse", `${baseline.tag}^{commit}`);
  if (baseline.version === "0.4.10") {
    assert.equal(sha, BOOTSTRAP_SHA, "The v0.4.10 baseline commit does not match the release workflow");
  }
  requireAncestor(sha);
  const remoteRefs = git("for-each-ref", "--format=%(refname)", "refs/remotes/origin/release").split("\n");
  if (remoteRefs.includes("refs/remotes/origin/release")) {
    requireAncestor("origin/release");
  }
  const records = git("log", "--no-show-signature", "--format=%H%x00%B%x00", `${sha}..HEAD`).split("\0");
  const commits = [];
  for (let i = 0; i + 1 < records.length; i += 2) {
    commits.push({ hash: records[i].trim(), message: records[i + 1].trim() });
  }
  const result = await previewCommits(baseline, commits);
  console.log(`Commit:   ${git("rev-parse", "--short", "HEAD")}`);
  console.log(`Previous: ${baseline.version} (${baseline.tag})`);
  console.log(`Change:   ${result.type ?? "none"}`);
  console.log(`Next:     ${result.version ?? "no release"}`);
  if (git("status", "--porcelain")) console.log("Note: uncommitted changes are excluded.");
  console.log("Based on local commits and tags. Run git fetch origin --tags to refresh remote history.");
  console.log("Version preview only; this does not verify CI or publishing credentials.");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`Release preview failed: ${error.message}`);
    process.exitCode = 1;
  });
}
