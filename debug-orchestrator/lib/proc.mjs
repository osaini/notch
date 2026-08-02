import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { access, constants } from 'node:fs/promises';
import path from 'node:path';

const IS_WINDOWS = process.platform === 'win32';

async function isExecutableFile(candidate) {
  try {
    await access(candidate, IS_WINDOWS ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve a command name against PATH (and PATHEXT on Windows) so the CLI can be
 * spawned directly instead of through a shell. Prefers real executables over
 * `.cmd`/`.bat` shims, because those cannot be spawned without cmd.exe.
 */
export async function resolveCommand(name) {
  if (name.includes(path.sep) || name.includes('/')) {
    return (await isExecutableFile(name)) ? path.resolve(name) : null;
  }

  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const extensions = IS_WINDOWS
    ? ['.exe', '.com', ...(process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').map((ext) => ext.toLowerCase()).filter(Boolean)]
    : [''];
  const seen = new Set();
  const ordered = extensions.filter((ext) => {
    if (seen.has(ext)) return false;
    seen.add(ext);
    return true;
  });

  for (const ext of ordered) {
    for (const dir of dirs) {
      const candidate = path.join(dir.replace(/^"|"$/g, ''), `${name}${ext}`);
      if (await isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}

function cmdQuote(token) {
  return /^[A-Za-z0-9_\-.:\\/=]+$/.test(token) ? token : `"${String(token).replace(/"/g, '""')}"`;
}

/**
 * Node cannot spawn a `.cmd`/`.bat` shim without a shell on Windows. Provider
 * CLIs resolve to real `.exe` files and take the direct path; only tooling such
 * as `npm.cmd` needs the cmd.exe wrapper, and its arguments are built here with
 * explicit quoting rather than handed to `shell: true`.
 */
export function spawnPlan(commandPath, args) {
  if (IS_WINDOWS && /\.(cmd|bat)$/i.test(commandPath)) {
    const commandLine = [commandPath, ...args].map(cmdQuote).join(' ');
    return {
      command: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', commandLine],
      windowsVerbatimArguments: true
    };
  }
  return { command: commandPath, args, windowsVerbatimArguments: false };
}

/** Kill only the process tree we spawned. Never touches sibling jobs. */
export function killProcessTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const pid = child.pid;
  if (!pid) return;
  if (IS_WINDOWS) {
    try {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).unref();
    } catch {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

/**
 * Spawn a command without a shell, stream stdout/stderr straight to disk, and
 * enforce a wall-clock timeout.
 *
 * Resolves with `{ status, exitCode, signal, timedOut, durationMs }` where status
 * is `succeeded`, `failed`, or `timed_out`. Never throws for a nonzero exit; a
 * failure to launch resolves as `failed` with an `error` string.
 */
export function spawnCapture({
  command,
  args,
  cwd,
  stdin = '',
  stdoutPath,
  stderrPath,
  timeoutMs,
  env = process.env
}) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let settled = false;
    let timedOut = false;
    let launchError = null;
    let timer = null;

    const stdoutStream = stdoutPath ? createWriteStream(stdoutPath) : null;
    const stderrStream = stderrPath ? createWriteStream(stderrPath) : null;
    const stderrTail = [];

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      const closes = [];
      for (const stream of [stdoutStream, stderrStream]) {
        if (!stream) continue;
        closes.push(
          new Promise((done) => {
            stream.end(() => done());
          })
        );
      }
      Promise.all(closes).then(() =>
        resolve({
          ...result,
          durationMs: Date.now() - startedAt,
          stderrTail: stderrTail.join('').slice(-4000)
        })
      );
    };

    let child;
    try {
      const plan = spawnPlan(command, args);
      child = spawn(plan.command, plan.args, {
        cwd,
        env,
        windowsHide: true,
        windowsVerbatimArguments: plan.windowsVerbatimArguments,
        detached: !IS_WINDOWS,
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch (error) {
      finish({ status: 'failed', exitCode: null, signal: null, timedOut: false, error: String(error?.message ?? error) });
      return;
    }

    child.on('error', (error) => {
      launchError = String(error?.message ?? error);
    });

    if (stdoutStream) child.stdout.pipe(stdoutStream);
    else child.stdout.resume();

    child.stderr.on('data', (chunk) => {
      stderrTail.push(chunk.toString('utf8'));
      if (stderrTail.length > 64) stderrTail.splice(0, stderrTail.length - 64);
    });
    if (stderrStream) child.stderr.pipe(stderrStream);
    else child.stderr.resume();

    if (typeof timeoutMs === 'number' && timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        killProcessTree(child);
      }, timeoutMs);
    }

    child.stdin.on('error', () => {
      /* the CLI may exit before consuming stdin; the exit code is what matters */
    });
    child.stdin.end(stdin);

    child.on('close', (code, signal) => {
      if (timedOut) {
        finish({ status: 'timed_out', exitCode: code, signal, timedOut: true, error: `timed out after ${timeoutMs} ms` });
        return;
      }
      if (launchError) {
        finish({ status: 'failed', exitCode: code, signal, timedOut: false, error: launchError });
        return;
      }
      finish({
        status: code === 0 ? 'succeeded' : 'failed',
        exitCode: code,
        signal,
        timedOut: false,
        error: code === 0 ? null : `exit code ${code}`
      });
    });
  });
}

/** Run a short command and capture stdout as a string. Used by preflight only. */
export function runCapture(command, args, { cwd, timeoutMs = 15 * 60 * 1000, env = process.env } = {}) {
  return new Promise((resolve) => {
    let child;
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    try {
      const plan = spawnPlan(command, args);
      child = spawn(plan.command, plan.args, {
        cwd,
        env,
        windowsHide: true,
        windowsVerbatimArguments: plan.windowsVerbatimArguments,
        detached: !IS_WINDOWS,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (error) {
      resolve({ status: 'failed', exitCode: null, stdout: '', stderr: String(error?.message ?? error) });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      stderr += String(error?.message ?? error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        status: timedOut ? 'timed_out' : code === 0 ? 'succeeded' : 'failed',
        exitCode: code,
        stdout,
        stderr
      });
    });
  });
}
