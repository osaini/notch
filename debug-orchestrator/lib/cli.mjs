export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

/** An expected operational failure. Reported as a message, not a stack trace. */
export class PipelineError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PipelineError';
  }
}

export const COMMANDS = ['preflight', 'scan', 'resume', 'report', 'implement', 'fix', 'help'];
export const PROVIDERS = ['claude', 'codex'];

/** Accepted by every command: they decide what to work on and how. */
const GLOBAL_VALUE_FLAGS = ['manifest', 'repo-root'];

const FLAG_SPEC = {
  preflight: { boolean: ['help'], value: [] },
  scan: { boolean: ['help'], value: ['shard', 'provider'] },
  resume: { boolean: ['help', 'latest'], value: ['run'] },
  report: { boolean: ['help', 'latest'], value: ['run'] },
  implement: {
    boolean: ['help', 'skip-baseline'],
    value: ['task', 'candidate', 'run', 'provider', 'max-rounds', 'clean']
  },
  fix: {
    boolean: ['help', 'latest', 'skip-baseline', 'include-tiebroken'],
    value: ['run', 'provider', 'max-fixes', 'max-rounds', 'clean']
  },
  help: { boolean: ['help'], value: [] }
};

/**
 * Render a copy-pasteable command for a hint.
 *
 * npm exposes the script that invoked us, so a repository that wires these up
 * as `bugs:scan`, `debug:scan`, or anything else gets its own names echoed
 * back. Outside npm we can only name the entry point directly.
 */
export function invocation(command, args = '') {
  const script = process.env.npm_lifecycle_event;
  if (script && script.includes(':')) {
    const namespace = script.slice(0, script.lastIndexOf(':'));
    return `npm run ${namespace}:${command}${args ? ` -- ${args}` : ''}`;
  }
  return `node debug-orchestrator/orchestrate.mjs ${command}${args ? ` ${args}` : ''}`;
}

export const USAGE = `Usage: node debug-orchestrator/orchestrate.mjs <command> [options]

Adversarial two-model bug discovery. Claude and Codex each scout the same code,
then challenge each other's findings; surviving candidates are reported.

Commands:
  preflight              Verify tooling, repository state, and the deterministic baseline.
  scan                   Create a new run and execute both dispatch tracks: each
                         provider finds bugs, the opposing one verifies them, the
                         two tracks are compared, and disagreements go to a tiebreak.
                         Read-only; stops at the report.
  resume                 Re-open an existing run and execute only outstanding jobs.
  report                 Regenerate the report from stored data without model calls.
  implement              Plan, critique, implement, and adversarially review one change
                         in an isolated git worktree. Never touches your checkout.
  fix                    Plan and implement a capped batch of a scan's verified findings,
                         one at a time, in one isolated worktree. Never touches your checkout.

Options:
  --repo-root <path>     Repository to analyse. Defaults to the git root of the
                         current directory.
  --manifest <path>      Shard manifest. Defaults to debug-orchestrator.json in
                         the repository root, then the bundled manifest.json.
  --shard <id>           scan only: limit the run to a single shard.
  --provider <name>      scan: run one provider (claude|codex). Smoke tests only;
                         one provider cannot form a track, so challenge is skipped.
                         implement/fix: which provider implements; the other reviews.
  --run <run-id>         resume/report/fix: target an existing run.
  --latest               resume/report/fix: target the most recently created run.
  --task <text>          implement: free-form task to carry out.
  --candidate <id>       implement: a candidate id from a completed scan run.
  --max-fixes <n>        fix: how many findings to fix in one batch (default 5).
  --max-rounds <n>       implement/fix: implement/review rounds per fix (default 3).
  --include-tiebroken    fix: also fix findings whose status came from a tiebreak.
                         Off by default: the two tracks contradicted each other there.
  --skip-baseline        implement/fix: do not run repository checks between rounds.
  --clean <run-id>       implement/fix: remove that run's worktree and branch, then exit.
  --help                 Show this message.

Neither implement nor fix writes to your checkout or your branches. Both work
inside .debug-runs/<run-id>/tree on a throwaway debug-impl/<run-id> branch. A fix
batch commits there between fixes so each fix's diff covers only its own work;
--clean deletes the branch and the tree wholesale.

Examples:
  node debug-orchestrator/orchestrate.mjs preflight
  node debug-orchestrator/orchestrate.mjs scan --shard core
  node debug-orchestrator/orchestrate.mjs resume --run 20260730-120000-f177f4d
  node debug-orchestrator/orchestrate.mjs report --latest
  node debug-orchestrator/orchestrate.mjs fix --latest --max-fixes 1
  node debug-orchestrator/orchestrate.mjs implement --task "Fix the retry backoff"
  node debug-orchestrator/orchestrate.mjs implement --candidate a1b2c3d4 --latest
  node debug-orchestrator/orchestrate.mjs implement --clean 20260731-090000-e2ad9e9

This spawns paid model calls. See the README for the cost model before scanning.`;

function tokenize(argv) {
  const tokens = [];
  for (const raw of argv) {
    if (raw.startsWith('--') && raw.includes('=')) {
      const index = raw.indexOf('=');
      tokens.push(raw.slice(0, index), raw.slice(index + 1));
    } else {
      tokens.push(raw);
    }
  }
  return tokens;
}

/**
 * Parse CLI arguments. Unknown commands, unknown flags, unknown providers, and
 * unknown shard ids all throw `UsageError`; the caller turns that into a nonzero
 * exit with concise usage text.
 */
export function parseArgs(argv, { shardIds = null } = {}) {
  const tokens = tokenize(argv);
  if (tokens.length === 0) throw new UsageError('No command provided.');

  const [command, ...rest] = tokens;
  if (command.startsWith('-')) {
    if (command === '--help' || command === '-h') return { command: 'help', options: {} };
    throw new UsageError(`Expected a command before options, received "${command}".`);
  }
  if (!COMMANDS.includes(command)) {
    throw new UsageError(`Unknown command "${command}". Expected one of: ${COMMANDS.join(', ')}.`);
  }

  const spec = FLAG_SPEC[command];
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === '-h') {
      options.help = true;
      continue;
    }
    if (!token.startsWith('--')) {
      throw new UsageError(`Unexpected positional argument "${token}" for command "${command}".`);
    }
    const name = token.slice(2);
    if (spec.boolean.includes(name)) {
      options[name] = true;
      continue;
    }
    if (spec.value.includes(name) || GLOBAL_VALUE_FLAGS.includes(name)) {
      const value = rest[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new UsageError(`Flag "--${name}" requires a value.`);
      }
      options[name] = value;
      index += 1;
      continue;
    }
    throw new UsageError(`Unknown flag "--${name}" for command "${command}".`);
  }

  if (options.help) return { command: 'help', options: {} };

  if (options.provider !== undefined && !PROVIDERS.includes(options.provider)) {
    throw new UsageError(`Unknown provider "${options.provider}". Expected one of: ${PROVIDERS.join(', ')}.`);
  }
  if (options.shard !== undefined && shardIds && !shardIds.includes(options.shard)) {
    throw new UsageError(`Unknown shard "${options.shard}". Expected one of: ${shardIds.join(', ')}.`);
  }
  if (command === 'resume' && !options.run && !options.latest) {
    throw new UsageError('Command "resume" requires --run <run-id> or --latest.');
  }
  if (command === 'report' && !options.run && !options.latest) {
    throw new UsageError('Command "report" requires --run <run-id> or --latest.');
  }
  if (command === 'fix' && !options.clean && !options.run && !options.latest) {
    throw new UsageError('Command "fix" requires --run <run-id> or --latest to locate the scan run.');
  }
  if (options.run && options.latest) {
    throw new UsageError('Use either --run <run-id> or --latest, not both.');
  }

  if (command === 'fix' && !options.clean) {
    if (options['max-fixes'] !== undefined) {
      const fixes = Number(options['max-fixes']);
      if (!Number.isInteger(fixes) || fixes < 1) {
        throw new UsageError(`--max-fixes must be a positive integer, received "${options['max-fixes']}".`);
      }
    }
    if (options['max-rounds'] !== undefined) {
      const rounds = Number(options['max-rounds']);
      if (!Number.isInteger(rounds) || rounds < 1) {
        throw new UsageError(`--max-rounds must be a positive integer, received "${options['max-rounds']}".`);
      }
    }
  }

  if (command === 'implement' && !options.clean) {
    if (!options.task && !options.candidate) {
      throw new UsageError('Command "implement" requires --task <text> or --candidate <id>.');
    }
    if (options.task && options.candidate) {
      throw new UsageError('Use either --task <text> or --candidate <id>, not both.');
    }
    if (options.candidate && !options.run && !options.latest) {
      throw new UsageError('--candidate needs --run <run-id> or --latest to locate the scan run.');
    }
    if (options['max-rounds'] !== undefined) {
      const rounds = Number(options['max-rounds']);
      if (!Number.isInteger(rounds) || rounds < 1) {
        throw new UsageError(`--max-rounds must be a positive integer, received "${options['max-rounds']}".`);
      }
    }
  }

  return { command, options };
}
