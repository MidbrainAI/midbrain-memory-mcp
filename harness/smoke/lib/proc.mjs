// Child-process helpers: spawn with a hard timeout, optional stdin, optional
// NDJSON line callback, and optional raw stdout capture to a file.
import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';

const children = new Map();
let stopping = false;
export async function stopChildProcesses() {
  stopping = true;
  const active = [...children.values()];
  for (const child of active) child.stop();
  await Promise.all(active.map(child => child.done));
}

export function spawnCapture(cmd, args, {
  cwd,
  env,
  timeoutMs = 120000,
  killGraceMs = 5000,
  input = '',
  stdoutFile = null,
  onStdoutLine = null,
  onStderrLine = null,
  signal = null,
} = {}) {
  if (stopping) return Promise.resolve({ code: 130, signal: 'SIGTERM', stdout: '', stderr: 'Run cancelled before process start', timedOut: false, durationMs: 0 });
  return new Promise((resolve) => {
    const started = Date.now();
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let buf = '';
    let errBuf = '';
    const out = stdoutFile ? createWriteStream(stdoutFile) : null;
    let child;
    try {
      child = spawn(cmd, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
    } catch (err) {
      if (out) out.end();
      resolve({ code: -1, signal: null, stdout, stderr: `[spawn error] ${err.message}`, timedOut, durationMs: 0, error: err.message });
      return;
    }
    let hard;
    let stopped;
    const done = new Promise(resolve => { stopped = resolve; });
    const kill = signal => {
      if (!children.has(child)) return;
      try {
        if (process.platform === 'win32') child.kill(signal);
        else process.kill(-child.pid, signal); // Include native CLI/MCP descendants.
      } catch { /* already gone */ }
    };
    const abort = () => {
      kill('SIGTERM');
      hard ||= setTimeout(() => kill('SIGKILL'), killGraceMs);
      hard.unref?.();
    };
    children.set(child, { stop: abort, done });
    const finished = () => { clearTimeout(hard); children.delete(child); stopped(); };
    const timer = setTimeout(() => { timedOut = true; abort(); }, timeoutMs);
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    const flushLines = (final = false) => {
      if (!onStdoutLine) return;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.trim()) onStdoutLine(line);
      }
      if (final && buf.trim()) {
        onStdoutLine(buf);
        buf = '';
      }
    };
    child.stdout.on('data', (chunk) => {
      const s = chunk.toString('utf8');
      stdout += s;
      if (out) out.write(s);
      buf += s;
      flushLines(false);
    });
    child.stderr.on('data', (chunk) => {
      const value = chunk.toString('utf8');
      stderr += value;
      if (!onStderrLine) return;
      errBuf += value;
      let i;
      while ((i = errBuf.indexOf('\n')) >= 0) {
        const line = errBuf.slice(0, i); errBuf = errBuf.slice(i + 1);
        if (line.trim()) onStderrLine(line);
      }
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      finished();
      signal?.removeEventListener('abort', abort);
      if (out) out.end();
      resolve({ code: -1, signal: null, stdout, stderr: `${stderr}\n[spawn error] ${err.message}`, timedOut, durationMs: Date.now() - started, error: err.message });
    });
    child.on('close', (code, exitSignal) => {
      clearTimeout(timer);
      finished();
      signal?.removeEventListener('abort', abort);
      flushLines(true);
      if (onStderrLine && errBuf.trim()) onStderrLine(errBuf);
      if (out) out.end();
      resolve({ code, signal: exitSignal, stdout, stderr, timedOut, durationMs: Date.now() - started });
    });
    if (input) child.stdin.write(input);
    child.stdin.end();
  });
}

export function whichSync(cmd, env = process.env) {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { env, encoding: 'utf8' });
  if (r.status !== 0) return null;
  return r.stdout.split(/\r?\n/)[0].trim() || null;
}

export function runSync(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}
