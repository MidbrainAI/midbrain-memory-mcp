import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { main } from '../install.mjs';
import { makeTestEnv } from './helpers/test-env.mjs';

const NO_KEY_MESSAGE =
  'No API key found. Run the installer interactively first or set MIDBRAIN_API_KEY.';

afterEach(() => {
  vi.restoreAllMocks();
});

async function writeCredentialFixture(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${value}\n`, { mode: 0o600 });
}

function muteInstallerOutput() {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
}

describe('global credential promotion with the real filesystem', () => {
  it('preserves a direct global file byte-for-byte with distinct client keys', async () => {
    const env = await makeTestEnv({ clients: ['opencode', 'claude'] });
    try {
      muteInstallerOutput();
      const opencodeKey = path.join(env.home, '.config', 'opencode', '.midbrain-key');
      const claudeKey = path.join(env.home, '.config', 'claude', '.midbrain-key');
      await writeCredentialFixture(opencodeKey, 'opencode-client-dummy');
      await writeCredentialFixture(claudeKey, 'claude-client-dummy');
      await writeCredentialFixture(env.paths.globalKey, 'global-preserve-dummy');
      const before = await fs.readFile(env.paths.globalKey);
      const beforeStat = await fs.stat(env.paths.globalKey);

      await main({ nonInteractive: true, skipRules: true });

      expect(await fs.readFile(env.paths.globalKey)).toEqual(before);
      expect((await fs.stat(env.paths.globalKey)).mtimeMs).toBe(beforeStat.mtimeMs);
    } finally {
      await env.restore();
    }
  });

  it('makes zero writes when non-interactive client credentials differ', async () => {
    const env = await makeTestEnv({ clients: ['opencode', 'claude'] });
    try {
      muteInstallerOutput();
      const opencodeKey = path.join(env.home, '.config', 'opencode', '.midbrain-key');
      const claudeKey = path.join(env.home, '.config', 'claude', '.midbrain-key');
      await writeCredentialFixture(opencodeKey, 'opencode-distinct-dummy');
      await writeCredentialFixture(claudeKey, 'claude-distinct-dummy');
      const beforeOpenCode = await fs.stat(opencodeKey);
      const beforeClaude = await fs.stat(claudeKey);

      await expect(main({ nonInteractive: true, skipRules: true }))
        .rejects.toThrow(/Distinct eligible credentials/);

      await expect(fs.access(env.paths.globalKey)).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await fs.stat(opencodeKey)).mtimeMs).toBe(beforeOpenCode.mtimeMs);
      expect((await fs.stat(claudeKey)).mtimeMs).toBe(beforeClaude.mtimeMs);
    } finally {
      await env.restore();
    }
  });

  it('never promotes a project credential into the global file', async () => {
    const env = await makeTestEnv({ clients: ['opencode'] });
    try {
      muteInstallerOutput();
      const projectDir = path.join(env.root, 'project');
      const projectKey = path.join(projectDir, '.midbrain', '.midbrain-key');
      await writeCredentialFixture(projectKey, 'project-only-dummy');
      process.env.MIDBRAIN_PROJECT_DIR = projectDir;

      await expect(main({ nonInteractive: true, skipRules: true }))
        .rejects.toThrow(NO_KEY_MESSAGE);
      await expect(fs.access(env.paths.globalKey)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await fs.readFile(projectKey, 'utf8')).toBe('project-only-dummy\n');
    } finally {
      await env.restore();
    }
  });
});
