import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { makeTestEnv } from './helpers/test-env.mjs';

let testEnv;
let globalKeyPath;
let opencodeKeyPath;

beforeAll(async () => {
  testEnv = await makeTestEnv();
  globalKeyPath = path.join(testEnv.home, '.config', 'midbrain', '.midbrain-key');
  opencodeKeyPath = path.join(testEnv.home, '.config', 'opencode', '.midbrain-key');
});

afterAll(async () => {
  await testEnv?.restore();
});

async function loadWriter() {
  return import('../shared/clients/credential-writer.mjs');
}

describe('writeCredential guard and validation', () => {
  it('refuses writes in Vitest when the sandbox marker is absent', async () => {
    const saved = process.env.MIDBRAIN_TEST_SANDBOX;
    delete process.env.MIDBRAIN_TEST_SANDBOX;
    try {
      const { CredentialWriteRefusedError, writeCredential } = await loadWriter();
      await expect(writeCredential({
        clientId: 'generic',
        scope: 'global',
        targetPath: globalKeyPath,
        key: 'guard-dummy',
      })).rejects.toBeInstanceOf(CredentialWriteRefusedError);
    } finally {
      if (saved === undefined) delete process.env.MIDBRAIN_TEST_SANDBOX;
      else process.env.MIDBRAIN_TEST_SANDBOX = saved;
    }
  });

  it('refuses a target outside the declared test sandbox', async () => {
    const { CredentialWriteRefusedError, writeCredential } = await loadWriter();
    const outside = path.join(
      path.dirname(testEnv.root),
      'midbrain-prd036-outside',
      'project',
      '.midbrain',
      '.midbrain-key',
    );
    await expect(writeCredential({
      clientId: 'generic',
      scope: 'project',
      targetPath: outside,
      projectDir: path.dirname(path.dirname(outside)),
      key: 'outside-dummy',
    })).rejects.toBeInstanceOf(CredentialWriteRefusedError);
  });

  it('refuses a sandbox rooted inside the real user home', async () => {
    const { CredentialWriteRefusedError, writeCredential } = await loadWriter();
    const saved = process.env.MIDBRAIN_TEST_SANDBOX;
    const unsafeRoot = os.userInfo().homedir;
    const projectDir = path.join(unsafeRoot, 'midbrain-prd036-never-write');
    process.env.MIDBRAIN_TEST_SANDBOX = unsafeRoot;
    try {
      await expect(writeCredential({
        clientId: 'generic',
        scope: 'project',
        targetPath: path.join(projectDir, '.midbrain', '.midbrain-key'),
        projectDir,
        key: 'nested-dummy',
      })).rejects.toBeInstanceOf(CredentialWriteRefusedError);
    } finally {
      process.env.MIDBRAIN_TEST_SANDBOX = saved;
    }
  });

  it('rejects a non-canonical client target', async () => {
    const { CredentialTargetError, writeCredential } = await loadWriter();
    await expect(writeCredential({
      clientId: 'opencode',
      scope: 'client',
      targetPath: path.join(testEnv.home, '.config', 'claude', '.midbrain-key'),
      key: 'wrong-target-dummy',
    })).rejects.toBeInstanceOf(CredentialTargetError);
  });

  // Regression: on Windows (and macOS via $TMPDIR) os.tmpdir() is itself nested
  // under the real user profile, so a legitimate temp-based sandbox lives under
  // the real home. The guard must NOT refuse that case — only a sandbox broad
  // enough to encompass the real home is unsafe.
  it('allows a sandbox nested under the real user home', async () => {
    const { writeCredential } = await loadWriter();
    const result = await writeCredential({
      clientId: 'generic',
      scope: 'global',
      targetPath: globalKeyPath,
      key: 'nested-sandbox-dummy',
    });
    expect(result.action).toBe('written');
    expect(await fs.readFile(globalKeyPath, 'utf8')).toBe('nested-sandbox-dummy\n');
    await fs.rm(globalKeyPath, { force: true });
  });
});

describe('writeCredential atomic writes', () => {
  it('creates a canonical key atomically with mode 0600', async () => {
    const { writeCredential } = await loadWriter();
    const result = await writeCredential({
      clientId: 'opencode',
      scope: 'client',
      targetPath: opencodeKeyPath,
      key: 'atomic-dummy',
    });

    expect(result).toEqual({ action: 'written', backupPath: null });
    expect(await fs.readFile(opencodeKeyPath, 'utf8')).toBe('atomic-dummy\n');
    if (process.platform !== 'win32') {
      expect((await fs.stat(opencodeKeyPath)).mode & 0o777).toBe(0o600);
    }
    await expect(fs.access(`${opencodeKeyPath}.tmp`)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves mtime when the existing key is identical', async () => {
    const { writeCredential } = await loadWriter();
    const before = await fs.stat(opencodeKeyPath);
    const result = await writeCredential({
      clientId: 'opencode',
      scope: 'client',
      targetPath: opencodeKeyPath,
      key: 'atomic-dummy',
    });
    const after = await fs.stat(opencodeKeyPath);

    expect(result).toEqual({ action: 'unchanged', backupPath: null });
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it('fails closed on a different existing key without approval', async () => {
    const { CredentialReplaceNotApprovedError, writeCredential } = await loadWriter();
    await expect(writeCredential({
      clientId: 'opencode',
      scope: 'client',
      targetPath: opencodeKeyPath,
      key: 'replacement-dummy',
    })).rejects.toBeInstanceOf(CredentialReplaceNotApprovedError);
    expect(await fs.readFile(opencodeKeyPath, 'utf8')).toBe('atomic-dummy\n');
    await expect(fs.access(`${opencodeKeyPath}.tmp`)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('surfaces an empty existing credential as a typed read error', async () => {
    const { CredentialReadError, writeCredential } = await loadWriter();
    const targetPath = path.join(testEnv.home, '.config', 'codex', '.midbrain-key');
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, '\n', { mode: 0o600 });

    const error = await writeCredential({
      clientId: 'codex',
      scope: 'client',
      targetPath,
      key: 'new-dummy',
    }).catch((err) => err);
    expect(error).toBeInstanceOf(CredentialReadError);
    expect(error.category).toBe('empty');
    expect(error.targetPath).toBe(targetPath);
    expect(await fs.readFile(targetPath, 'utf8')).toBe('\n');
  });

  it('surfaces corrupt existing credential bytes as a typed read error', async () => {
    const { CredentialReadError, writeCredential } = await loadWriter();
    const targetPath = path.join(testEnv.home, '.config', 'hermes', '.midbrain-key');
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, Buffer.from([0x61, 0x00, 0x62]), { mode: 0o600 });

    const error = await writeCredential({
      clientId: 'hermes',
      scope: 'client',
      targetPath,
      key: 'new-dummy',
    }).catch((err) => err);
    expect(error).toBeInstanceOf(CredentialReadError);
    expect(error.category).toBe('corrupt');
    expect(error.targetPath).toBe(targetPath);
  });

  it.skipIf(process.platform === 'win32')(
    'surfaces EACCES as a typed read error without a partial file',
    async () => {
      const { CredentialReadError, writeCredential } = await loadWriter();
      const targetPath = path.join(testEnv.home, '.config', 'claude', '.midbrain-key');
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.writeFile(targetPath, 'locked-dummy\n', { mode: 0o600 });
      await fs.chmod(targetPath, 0o000);
      try {
        const error = await writeCredential({
          clientId: 'claude',
          scope: 'client',
          targetPath,
          key: 'new-dummy',
        }).catch((err) => err);
        expect(error).toBeInstanceOf(CredentialReadError);
        expect(error.category).toBe('permission-denied');
        await expect(fs.access(`${targetPath}.tmp`)).rejects.toMatchObject({ code: 'ENOENT' });
      } finally {
        await fs.chmod(targetPath, 0o600);
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'surfaces an unwritable parent mkdir failure as a typed error without a partial file',
    async () => {
      const { CredentialWriteError, writeCredential } = await loadWriter();
      const projectDir = path.join(testEnv.root, 'mkdir-permission-project');
      const targetPath = path.join(projectDir, '.midbrain', '.midbrain-key');
      await fs.mkdir(projectDir, { recursive: true, mode: 0o700 });
      await fs.chmod(projectDir, 0o555);
      try {
        const error = await writeCredential({
          clientId: 'generic',
          scope: 'project',
          targetPath,
          projectDir,
          key: 'new-dummy',
        }).catch((err) => err);
        expect(error).toBeInstanceOf(CredentialWriteError);
        expect(error.category).toBe('permission-denied');
        expect(error.targetPath).toBe(targetPath);
        await expect(fs.access(targetPath)).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(fs.access(`${targetPath}.tmp`)).rejects.toMatchObject({ code: 'ENOENT' });
      } finally {
        await fs.chmod(projectDir, 0o700);
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'surfaces an unreadable parent realpath failure as a typed error without a partial file',
    async () => {
      const { CredentialWriteError, writeCredential } = await loadWriter();
      const projectDir = path.join(testEnv.root, 'realpath-permission-project');
      const targetPath = path.join(projectDir, '.midbrain', '.midbrain-key');
      await fs.mkdir(projectDir, { recursive: true, mode: 0o700 });
      await fs.chmod(projectDir, 0o000);
      try {
        const error = await writeCredential({
          clientId: 'generic',
          scope: 'project',
          targetPath,
          projectDir,
          key: 'new-dummy',
        }).catch((err) => err);
        expect(error).toBeInstanceOf(CredentialWriteError);
        expect(error.category).toBe('permission-denied');
        expect(error.targetPath).toBe(targetPath);
        await expect(fs.access(targetPath)).rejects.toMatchObject({ code: 'EACCES' });
        await expect(fs.access(`${targetPath}.tmp`)).rejects.toMatchObject({ code: 'EACCES' });
      } finally {
        await fs.chmod(projectDir, 0o700);
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'refuses a pre-existing temporary-file symlink without touching its target',
    async () => {
      const { CredentialWriteError, writeCredential } = await loadWriter();
      const targetPath = path.join(testEnv.home, '.config', 'nanoclaw', '.midbrain-key');
      const unrelated = path.join(testEnv.root, 'unrelated.txt');
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.writeFile(unrelated, 'unrelated\n');
      await fs.symlink(unrelated, `${targetPath}.tmp`);

      await expect(writeCredential({
        clientId: 'nanoclaw',
        scope: 'client',
        targetPath,
        key: 'new-dummy',
      })).rejects.toBeInstanceOf(CredentialWriteError);
      expect(await fs.readFile(unrelated, 'utf8')).toBe('unrelated\n');
      expect(await fs.readlink(`${targetPath}.tmp`)).toBe(unrelated);
    },
  );
});

describe('credential replacement backups', () => {
  it('backs up the prior credential at mode 0600 before approved replacement', async () => {
    const { writeCredential } = await loadWriter();
    const targetPath = path.join(testEnv.home, '.config', 'midbrain', '.midbrain-key');
    const prior = 'prior-global-dummy\n';
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, prior, { mode: 0o600 });

    const result = await writeCredential({
      clientId: 'generic',
      scope: 'global',
      targetPath,
      key: 'next-global-dummy',
      replaceApproved: true,
    });

    expect(result.action).toBe('written');
    expect(result.backupPath).toMatch(/\.midbrain-key\.bak-\d{8}T\d{6}Z$/);
    if (process.platform !== 'win32') {
      expect((await fs.stat(result.backupPath)).mode & 0o777).toBe(0o600);
    }
    const digest = (value) => createHash('sha256').update(value).digest('hex');
    expect(digest(await fs.readFile(result.backupPath))).toBe(digest(prior));
    expect(await fs.readFile(targetPath, 'utf8')).toBe('next-global-dummy\n');
  });

  it('uses a deterministic -2 suffix for a same-second backup collision', async () => {
    const { backupCredential } = await loadWriter();
    const targetPath = path.join(testEnv.home, '.config', 'claude', '.midbrain-key');
    const now = new Date('2026-07-29T04:00:05.000Z');
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, 'collision-dummy\n', { mode: 0o600 });

    const first = await backupCredential(targetPath, { now });
    const second = await backupCredential(targetPath, { now });

    expect(first).toBe(`${targetPath}.bak-20260729T040005Z`);
    expect(second).toBe(`${targetPath}.bak-20260729T040005Z-2`);
    expect(await fs.readFile(first, 'utf8')).toBe('collision-dummy\n');
    expect(await fs.readFile(second, 'utf8')).toBe('collision-dummy\n');
  });

  it('does not create a backup for an unapproved replacement', async () => {
    const { writeCredential } = await loadWriter();
    const targetPath = path.join(testEnv.home, '.config', 'codex', '.midbrain-key');
    await fs.chmod(targetPath, 0o600);
    await fs.writeFile(targetPath, 'keep-dummy\n');

    await expect(writeCredential({
      clientId: 'codex',
      scope: 'client',
      targetPath,
      key: 'reject-dummy',
    })).rejects.toMatchObject({ category: 'replacement-not-approved' });
    const entries = await fs.readdir(path.dirname(targetPath));
    expect(entries.filter((entry) => entry.startsWith('.midbrain-key.bak-'))).toEqual([]);
  });
});

describe('credential writer delegation regression', () => {
  it('routes every production key writer through writeCredential', async () => {
    const adapterFiles = [
      'generic.mjs',
      'opencode.mjs',
      'claude.mjs',
      'codex.mjs',
      'nanoclaw.mjs',
      'hermes.mjs',
    ];
    const sources = await Promise.all(adapterFiles.map(async (fileName) => ({
      fileName,
      source: await fs.readFile(new URL(`../shared/clients/${fileName}`, import.meta.url), 'utf8'),
    })));

    for (const { fileName, source } of sources) {
      expect(source, fileName).toContain('writeCredential');
      expect(source, fileName).not.toMatch(/\bwriteSecure\s*\(/);
      expect(source, fileName).not.toMatch(/writeFile\([^)]*\bkey\b/);
    }
    expect(sources.find(({ fileName }) => fileName === 'generic.mjs').source)
      .toMatch(/setProjectKey[\s\S]*writeCredential/);

    const utilsSource = await fs.readFile(
      new URL('../shared/clients/utils.mjs', import.meta.url),
      'utf8',
    );
    expect(utilsSource).not.toMatch(/\bwriteSecure\s*\(/);
  });
});
