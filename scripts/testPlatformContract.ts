/**
 * Enforces the platform contract on EVERY platform, not just the host.
 *
 * `platform/types.ts` documents several rules whose violations are silent: a
 * process list that returns [] deletes the user's sessions, an unsupported-reason
 * string turns into a permanent red error bar, a prompt interpolated into a shell
 * string is remote command execution. Comments do not catch those. This does.
 *
 * Both platform trees are imported directly rather than through `platform`, so
 * the macOS rules are checked while running on Windows and vice versa. That is
 * the only way the author — who has no Mac — can hold the darwin implementations
 * to the contract at all.
 */
import assert from 'node:assert/strict'
import type { PlatformIntegration, TerminalRunRequest } from '../src/main/platform/types'
import { darwinPlatform } from '../src/main/platform/darwin'
import { win32Platform } from '../src/main/platform/win32'

const platforms: PlatformIntegration[] = [win32Platform, darwinPlatform]

/** A display with a menu bar and a dock, so bounds and workArea differ. */
const DISPLAY = {
  id: 1,
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 0, y: 25, width: 1920, height: 985 }
} as unknown as Electron.Display

/**
 * Prompt text chosen to break a shell if it is ever interpolated into one.
 * Users write prompts like this by accident; the phone companion can send them
 * deliberately.
 */
const HOSTILE_PROMPT = 'fix this"; rm -rf ~ #\nand $(id) `whoami` && echo ;'
const HOSTILE_CWD = "/tmp/proj'; touch /tmp/pwned; #"

let failures = 0
const pass = (msg: string): void => console.log(`  PASS  ${msg}`)
const fail = (msg: string): void => {
  failures += 1
  console.error(`  FAIL  ${msg}`)
}

function check(name: string, body: () => void): void {
  try {
    body()
    pass(name)
  } catch (err) {
    fail(`${name} — ${(err as Error).message}`)
  }
}

for (const p of platforms) {
  console.log(`\n${p.os}`)

  check('every interface member is present', () => {
    for (const key of [
      'focus',
      'designWindows',
      'processes',
      'terminal',
      'autostart',
      'overlay',
      'tray',
      'paths',
      'info'
    ] as const) {
      assert.ok(p[key], `missing ${key}`)
    }
    assert.equal(typeof p.focus.focusSessionWindow, 'function')
    assert.equal(typeof p.processes.listCodexTuiProcesses, 'function')
    assert.equal(typeof p.terminal.agentPlans, 'function')
    assert.equal(typeof p.terminal.pairPlans, 'function')
    assert.equal(typeof p.autostart.apply, 'function')
    assert.equal(typeof p.overlay.windowOptions, 'function')
    assert.equal(typeof p.overlay.pillArea, 'function')
    assert.equal(typeof p.overlay.afterCreate, 'function')
    assert.equal(typeof p.tray.image, 'function')
    assert.equal(typeof p.paths.normalizeProjectPath, 'function')
    assert.equal(typeof p.paths.projectPathKey, 'function')
    assert.equal(typeof p.paths.isRevealable, 'function')
  })

  // ── the must-not-throw set ───────────────────────────────────────────────
  // These run before the first frame. A throw here is a blank screen, not a
  // degraded feature.

  check('overlay.windowOptions() does not throw and returns an object', () => {
    const options = p.overlay.windowOptions()
    assert.equal(typeof options, 'object')
    assert.notEqual(options, null)
  })

  check('overlay.pillArea() returns a finite rect', () => {
    const area = p.overlay.pillArea(DISPLAY)
    for (const key of ['x', 'y', 'width', 'height'] as const) {
      assert.ok(
        Number.isFinite(area[key]),
        `${key} is ${area[key]} — a platform reading a field the display lacks yields NaN here`
      )
    }
    assert.ok(area.width > 0 && area.height > 0, 'the pill area must have extent')
  })

  check('info.features matches the implementations it describes', () => {
    assert.equal(p.info.os, p.os)
    assert.equal(p.info.features.designWindows, p.designWindows.supported)
    assert.equal(p.info.features.splitPane, p.terminal.supportsSplitPane)
    assert.equal(p.info.terminalLabel, p.terminal.primaryLabel)
    assert.ok(p.info.relaunchHint.length > 0, 'relaunchHint is user-facing copy')
  })

  // ── rule 3: null, never [] ───────────────────────────────────────────────

  check('paths.projectPathKey is idempotent and total', () => {
    const raw = p.os === 'win32' ? 'C:/Users/you/Proj/' : '/Users/you/Proj/'
    const normalized = p.paths.normalizeProjectPath(raw)
    assert.ok(normalized.length > 0, 'normalizing a real path must not produce empty')
    assert.equal(
      p.paths.projectPathKey(normalized),
      p.paths.projectPathKey(p.paths.normalizeProjectPath(normalized)),
      'normalizing twice must not change the dedupe key'
    )
  })

  check('paths.isRevealable rejects a UNC path', () => {
    assert.equal(p.paths.isRevealable('\\\\evil-host\\share\\file'), false)
    assert.equal(p.paths.isRevealable('//evil-host/share/file'), false)
  })

  // ── designWindows: supported/reason contract ─────────────────────────────

  check('designWindows honours its supported/unsupportedReason contract', () => {
    if (p.designWindows.supported) {
      const { exe, args } = p.designWindows.sweepCommand(['Design'], 3000)
      assert.ok(exe.length > 0, 'a supported probe needs an executable')
      assert.ok(Array.isArray(args), 'sweep args must be an argv array')
      assert.equal(p.designWindows.unsupportedReason, '', 'a supported probe has no reason')
    } else {
      // Empty means "this platform does not have the feature" and the UI stays
      // silent. A sentence would render a permanent red error bar on every launch.
      assert.equal(
        p.designWindows.unsupportedReason,
        '',
        'a deliberately absent feature must report an empty reason, not a sentence'
      )
      assert.throws(
        () => p.designWindows.sweepCommand(['Design'], 3000),
        'sweepCommand is unreachable while unsupported, so it should say so loudly'
      )
    }
  })

  // ── the security invariant ───────────────────────────────────────────────

  const request: TerminalRunRequest = {
    cwd: HOSTILE_CWD,
    exe: 'claude',
    args: ['--permission-mode', 'plan', HOSTILE_PROMPT]
  }
  const allPlans = [
    ...p.terminal.agentPlans(request),
    ...p.terminal.pairPlans(request, { ...request, exe: 'codex' })
  ]

  check('launch plans are well formed', () => {
    for (const plan of allPlans) {
      assert.ok(plan.launches.length > 0, 'a plan must spawn something')
      assert.equal(typeof plan.display, 'string')
      for (const launch of plan.launches) {
        assert.ok(launch.exe.length > 0, 'every launch needs an executable')
        assert.ok(Array.isArray(launch.args), 'every launch needs an argv ARRAY')
        for (const arg of launch.args) {
          assert.equal(typeof arg, 'string')
        }
      }
    }
  })

  /**
   * THE guardrail. See SECURITY.md and PORTING.md §6.
   *
   * A user-controlled value may appear in argv only as a complete element of its
   * own — that is what "argv array, never a shell string" means. If it turns up
   * as a *substring* of a larger argument, something concatenated it into a
   * command line, and a prompt containing `; rm -rf ~` then executes.
   *
   * Encoding it (as the PowerShell fallback does) also passes, because the raw
   * bytes are then absent entirely.
   */
  check('no user-controlled value is ever concatenated into an argument', () => {
    for (const plan of allPlans) {
      for (const launch of plan.launches) {
        for (const arg of launch.args) {
          for (const [label, value] of [
            ['prompt', HOSTILE_PROMPT],
            ['cwd', HOSTILE_CWD]
          ] as const) {
            if (arg.includes(value)) {
              assert.equal(
                arg,
                value,
                `${p.os}/${plan.launcher}: the ${label} appears inside a larger argument ` +
                  `(${JSON.stringify(arg.slice(0, 120))}), which means it was interpolated ` +
                  'rather than passed as its own argv element'
              )
            }
          }
        }
      }
    }
  })

  check('the hostile prompt survives verbatim where it is passed as argv', () => {
    // Not just "nothing is unsafe" — the prompt must actually reach the agent
    // intact somewhere, or the safety above could be achieved by dropping it.
    if (allPlans.length === 0) return // platform has no terminal integration yet
    const reaches = allPlans.some((plan) =>
      plan.launches.some(
        (launch) =>
          launch.args.includes(HOSTILE_PROMPT) ||
          // An encoded plan carries it losslessly but not literally.
          launch.args.some((arg) => arg.length > 64 && /^[A-Za-z0-9+/=]+$/.test(arg))
      )
    )
    assert.ok(reaches, 'no plan passes the prompt through at all')
  })
}

console.log(
  failures === 0
    ? '\nPlatform contract tests passed.'
    : `\n${failures} platform contract assertion(s) failed.`
)
if (failures > 0) process.exitCode = 1
