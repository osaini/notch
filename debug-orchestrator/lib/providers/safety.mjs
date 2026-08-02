/**
 * Flags that must never appear in a discovery or challenge command line.
 *
 * Discovery and challenge jobs are read-only by contract: they may not edit the
 * repository, and they may not be granted an escape hatch that would let them.
 * `assertReadOnlyArgs` is called by both adapters before spawning, so a future
 * edit to argument construction fails loudly instead of silently widening
 * permissions.
 */
const FORBIDDEN_FLAGS = [
  '--dangerously-bypass-approvals-and-sandbox',
  '--dangerously-skip-permissions',
  '--allow-dangerously-skip-permissions',
  '--add-dir',
  '--yolo',
  '--full-auto'
];

const FORBIDDEN_VALUES = ['danger-full-access', 'workspace-write', 'bypasspermissions', 'acceptedits'];

const WRITE_CAPABLE_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash', 'Task', 'WebFetch', 'WebSearch'];

export function findWriteCapableArgs(args) {
  const violations = [];
  for (const raw of args) {
    const arg = String(raw);
    const lower = arg.toLowerCase();

    if (FORBIDDEN_FLAGS.some((flag) => lower === flag || lower.startsWith(`${flag}=`))) {
      violations.push(`forbidden flag: ${arg}`);
      continue;
    }
    if (FORBIDDEN_VALUES.includes(lower)) {
      violations.push(`forbidden value: ${arg}`);
      continue;
    }
    // Tool lists are comma or space separated; check each entry exactly so a
    // path such as `src/main/dispatcher.ts` is never mistaken for a tool name.
    if (arg.startsWith('-')) continue;
    const entries = arg.split(/[,\s]+/).filter(Boolean);
    if (entries.length && entries.every((entry) => /^[A-Za-z]+$/.test(entry))) {
      for (const entry of entries) {
        if (WRITE_CAPABLE_TOOLS.includes(entry)) violations.push(`write-capable tool: ${entry}`);
      }
    }
  }
  return violations;
}

export function assertReadOnlyArgs(provider, args) {
  const violations = findWriteCapableArgs(args);
  if (violations.length) {
    throw new Error(`${provider} command would grant write access (${violations.join('; ')})`);
  }
}

/**
 * Flags that stay forbidden even for the implementer.
 *
 * The implement phase is allowed to edit files — that is its job — but only
 * inside its own worktree. These are the flags that would let it escape that
 * boundary or drop the sandbox entirely, so they remain rejected before spawn.
 * `workspace-write` and `acceptEdits` are deliberately absent: they are how the
 * implementer is granted its scoped write access.
 */
const FORBIDDEN_EVEN_WHEN_WRITING = [
  '--dangerously-bypass-approvals-and-sandbox',
  '--dangerously-skip-permissions',
  '--allow-dangerously-skip-permissions',
  '--add-dir',
  '--yolo',
  '--full-auto'
];

const FORBIDDEN_WRITE_VALUES = ['danger-full-access', 'bypasspermissions'];

export function findUnscopedWriteArgs(args) {
  const violations = [];
  for (const raw of args) {
    const lower = String(raw).toLowerCase();
    if (FORBIDDEN_EVEN_WHEN_WRITING.some((flag) => lower === flag || lower.startsWith(`${flag}=`))) {
      violations.push(`forbidden flag: ${raw}`);
    } else if (FORBIDDEN_WRITE_VALUES.includes(lower)) {
      violations.push(`forbidden value: ${raw}`);
    }
  }
  return violations;
}

/**
 * Assert an implementer command line can only write inside `worktreePath`.
 *
 * Two independent conditions: no escape-hatch flag, and the working directory
 * the provider is pointed at is the run's own worktree. The second is what stops
 * a construction bug from turning the implementer loose on the user's checkout.
 */
export function assertWriteScopedArgs(provider, args, worktreePath) {
  const violations = findUnscopedWriteArgs(args);
  if (violations.length) {
    throw new Error(`${provider} implement command is not sandbox-scoped (${violations.join('; ')})`);
  }
  if (!worktreePath) {
    throw new Error(`${provider} implement command requires a worktree path`);
  }
  const cdIndex = args.indexOf('--cd');
  if (cdIndex !== -1 && args[cdIndex + 1] !== worktreePath) {
    throw new Error(
      `${provider} implement command targets ${args[cdIndex + 1]}, not the run worktree ${worktreePath}`
    );
  }
}

/** Argv is stored in job records; long schema payloads are replaced by a digest. */
export function redactArgs(args, redactions = []) {
  return args.map((arg) => {
    const hit = redactions.find((entry) => entry.value === arg);
    return hit ? hit.placeholder : arg;
  });
}
