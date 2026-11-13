export default {
  branches: ["release"],
  repositoryUrl: "https://github.com/MidbrainAI/midbrain-memory-mcp.git",
  // Historical v1.1.0 predates the 0.x npm releases. Keep it out of discovery.
  tagFormat: "npm-v${version}",
  plugins: [
    "@semantic-release/commit-analyzer",
    "@semantic-release/release-notes-generator",
    "@semantic-release/changelog",
    "@semantic-release/npm",
    "./scripts/release-guard.mjs",
    ["@semantic-release/git", {
      assets: ["package.json", "package-lock.json", "CHANGELOG.md"],
      message: "chore(release): ${nextRelease.version} [skip ci]\n\n${nextRelease.notes}",
    }],
    ["@semantic-release/github", {
      successComment: false,
      failComment: false,
      failTitle: false,
      releasedLabels: false,
    }],
  ],
};
