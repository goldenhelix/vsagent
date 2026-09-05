import { describe, expect, it } from 'vitest'
import { stripComments } from '../../src/shared/source-scan/source-tree-scan'

/**
 * Detects whether a test file's suite is gated to run only on win32 (Windows).
 *
 * WHAT THIS DETECTS -- a file is Windows-gated when its name is `*.win32.test.*`
 * / `*.win32.spec.*`, or when it contains ANY suite-level gate, nested ones
 * included, spelled:
 *   - `describe.runIf(<true only on win32>)`, `describe.skipIf(<false only on win32>)`
 *   - `const d = <true only on win32> ? describe : describe.skip`, and the
 *     `? describe.skip : describe` inversion
 * where the condition is `process.platform === 'win32'` / `!== 'win32'`, a
 * compound `<win32 check> && <anything>`, or a `const`/`let` in the same file
 * assigned from either -- so `const RUN_REAL = platform === 'win32' && env…`
 * used as `describe.runIf(RUN_REAL)` is detected, whatever the flag is named
 * and whichever polarity it was written in. Quote style, spacing and the
 * `describe`/`suite` spelling are tolerated. Nested gates count because a
 * win32-only block buried three levels down is still Windows-only.
 *
 * WHAT THIS CANNOT DETECT -- known blind spots, each deliberate:
 *   - `it`/`test`-level gates. A single win32-only case inside a cross-platform
 *     suite is not a whole-suite gate.
 *   - a gate whose condition crosses a module boundary or a function call --
 *     an imported flag, an imported `describeOnWindows`, `isWindows()`.
 *   - `runIf(<win32> || <x>)` and `skipIf(<not win32> && <x>)` are rejected on
 *     purpose: both can run off Windows, so neither is a win32-only gate. That
 *     holds whether the condition is written at the gate or routed through a
 *     named flag -- the two spellings used to disagree.
 */

const WIN32_TRUE_EXPRESSION = String.raw`process\.platform\s*===\s*['"]win32['"]`
const WIN32_FALSE_EXPRESSION = String.raw`process\.platform\s*!==\s*['"]win32['"]`
const SUITE = String.raw`(?:describe|suite)`

/**
 * Named flags resolved from their assignment in the same file, so polarity is
 * read rather than guessed from the name.
 *
 * Why the trailing lookahead: `const d = platform === 'win32' ? describe : …`
 * is a suite alias, not a boolean, and must not be collected as one.
 *
 * Why the two patterns differ on `&&`: a second conjunct NARROWS a
 * truthy-on-Windows flag, which stays Windows-only, but WIDENS a
 * falsy-on-Windows one -- `p = platform !== 'win32' && x` used as `skipIf(p)`
 * runs on Windows AND on POSIX whenever `x` is false, so it is not a
 * Windows-only gate. One lookahead shared across both polarities had that
 * backwards, and routing the condition through a named flag flipped the answer
 * the literal form got right. `||` is excluded from both.
 */
const FLAG_TRUE_ASSIGNMENT = new RegExp(
  String.raw`(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*${WIN32_TRUE_EXPRESSION}(?=\s*(?:&&|;|\r?\n|$))`,
  'g'
)
const FLAG_FALSE_ASSIGNMENT = new RegExp(
  String.raw`(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*${WIN32_FALSE_EXPRESSION}(?=\s*(?:;|\r?\n|$))`,
  'g'
)

function escapeForAlternation(name) {
  return name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Never-matching branch, so an empty flag set cannot widen a pattern. */
const MATCHES_NOTHING = String.raw`(?!)`

function alternation(names) {
  return names.length === 0 ? MATCHES_NOTHING : names.map(escapeForAlternation).join('|')
}

function buildGates(source) {
  const trueOnWindows = [...source.matchAll(FLAG_TRUE_ASSIGNMENT)].map(([, name]) => name)
  const falseOnWindows = [...source.matchAll(FLAG_FALSE_ASSIGNMENT)].map(([, name]) => name)
  const isTrue = `(?:${WIN32_TRUE_EXPRESSION}|\\b(?:${alternation(trueOnWindows)})\\b)`
  const isFalse = `(?:${WIN32_FALSE_EXPRESSION}|!\\s*(?:${alternation(trueOnWindows)})\\b|\\b(?:${alternation(falseOnWindows)})\\b)`
  return [
    // `\)` or `&&` after the condition: a bare gate, or a compound one whose
    // remaining conjuncts only narrow it further. Anchoring on `\)` alone was
    // this guard's own bug -- `runIf(win32 && hasAddon)` went undetected.
    new RegExp(String.raw`\b${SUITE}\s*\.\s*runIf\s*\(\s*${isTrue}\s*(?:\)|&&)`),
    new RegExp(String.raw`\b${SUITE}\s*\.\s*skipIf\s*\(\s*${isFalse}\s*(?:\)|\|\|)`),
    // `(?!\s*\.\s*skip)`: `platform === 'win32' ? describe.skip : describe` is
    // the POSIX-only gate, the exact opposite of the class, and seven files
    // use it.
    new RegExp(String.raw`=\s*${isTrue}\s*\?\s*${SUITE}\s*(?!\s*\.\s*skip)`),
    new RegExp(String.raw`=\s*${isFalse}\s*\?\s*${SUITE}\s*\.\s*skip`)
  ]
}

/** Exported shape of the rule, so the fixtures below exercise the real matcher. */
export function isWindows32GatedTestFile(path, source) {
  if (/\.win32\.(?:test|spec)\./.test(path)) {
    return true
  }
  // Prose about a gate is not a gate; the shared stripper tracks quote state so
  // a slash-star inside a string cannot blank live code.
  const code = stripComments(source)
  return buildGates(code).some((gate) => gate.test(code))
}

/**
 * True when the env read REACHES the gate: the win32 check is compound, and one
 * of its other conjuncts either reads `process.env` itself or names a const
 * that does.
 *
 * "Mentions an env var anywhere in the file" is not enough and was the earlier
 * bug here. `runIf(platform === 'win32' && hasAddon)` in a file that happens to
 * read `process.env.RUNNER_TEMP` for a temp dir is a test CI COULD run -- the
 * native-addon-bytes shape, exactly what this effort exists to keep in CI --
 * and it would have parked in MANUAL_OPT_IN unnoticed. Only the cap number
 * stood in the way, and a number is not an argument.
 *
 * One hop is enough for every real case: `distro = process.env.ORCA_TEST_WSL_DISTRO`
 * then `runIf(platform === 'win32' && Boolean(distro))`. Deeper chains fail
 * closed -- the file reads as registrable, which is the safe direction.
 */
const WIN32_CONJUNCT = new RegExp(String.raw`${WIN32_TRUE_EXPRESSION}\s*&&([^\n]*)`, 'g')
const ENV_READ = /process\.env\.[A-Za-z0-9_]+/
const IDENTIFIER = /[A-Za-z_$][\w$]*/g

function isAssignedFromEnv(name, code) {
  return new RegExp(
    String.raw`(?:const|let|var)\s+${escapeForAlternation(name)}\s*=[^\n]*process\.env\.`
  ).test(code)
}

export function requiresEnvOptIn(source) {
  const code = stripComments(source)
  return [...code.matchAll(WIN32_CONJUNCT)].some(([, conjunct]) => {
    if (ENV_READ.test(conjunct)) {
      return true
    }
    return [...conjunct.matchAll(IDENTIFIER)].some(([name]) => isAssignedFromEnv(name, code))
  })
}

/**
 * Any `runs-on` that could put a job on Windows.
 *
 * Not an equality test against `windows-2022`: `windows-latest` resolves to the
 * same image today, a label array or `{ group, labels }` object is valid YAML
 * here, and a `${{ matrix.os }}` expression cannot be resolved from the file at
 * all. An unresolvable expression counts as "could be Windows" so it fails
 * closed -- someone has to look rather than have a second lane appear silently.
 */
export function couldRunOnWindows(runsOn) {
  const labels =
    typeof runsOn === 'string'
      ? [runsOn]
      : Array.isArray(runsOn)
        ? runsOn
        : [...(runsOn?.labels ?? []), runsOn?.group ?? ''].flat()
  return labels.some((label) => /windows/i.test(String(label)) || String(label).includes('${{'))
}

describe('manual opt-in classification', () => {
  it('requires the env read to reach the gate', () => {
    // The parking attack: a compound gate CI could satisfy, in a file that
    // happens to read an unrelated env var. This is the native-addon-bytes
    // shape, and it must read as registrable.
    expect(
      requiresEnvOptIn(
        "const tmp = process.env.RUNNER_TEMP\ndescribe.runIf(process.platform === 'win32' && hasAddon)('x', () => {})"
      )
    ).toBe(false)
    // One hop through a const: the real shape of the ten listed suites.
    expect(
      requiresEnvOptIn(
        "const distro = process.env.ORCA_TEST_WSL_DISTRO\ndescribe.runIf(process.platform === 'win32' && Boolean(distro))('x', () => {})"
      )
    ).toBe(true)
    // Read inline in the conjunct: the other real shape.
    expect(
      requiresEnvOptIn(
        "const RUN = process.platform === 'win32' && process.env.ORCA_REAL_X === '1'"
      )
    ).toBe(true)
  })

  it('requires the gate to be compound at all', () => {
    // A bare `runIf(win32)` file -- which CI can run -- must never park as
    // manual, however much `process.env` the file reads elsewhere.
    expect(
      requiresEnvOptIn(
        "const t = process.env.CI\ndescribe.runIf(process.platform === 'win32')('x', () => {})"
      )
    ).toBe(false)
    // The case that makes the `&&` in WIN32_CONJUNCT load-bearing rather than
    // decorative: an env read on the SAME line as a bare gate. Drop the `&&`
    // and this reads as manual, which is the parking hole reopened.
    expect(
      requiresEnvOptIn(
        "describe.runIf(process.platform === 'win32')(`x ${process.env.ORCA_TAG}`, () => {})"
      )
    ).toBe(false)
  })
})

describe('Windows runner detection', () => {
  it('reads every runs-on spelling that could land on Windows', () => {
    expect(couldRunOnWindows('windows-2022')).toBe(true)
    // The spelling that would have slipped past an equality test.
    expect(couldRunOnWindows('windows-latest')).toBe(true)
    expect(couldRunOnWindows(['self-hosted', 'Windows', 'X64'])).toBe(true)
    expect(couldRunOnWindows({ group: 'windows-runners', labels: ['x64'] })).toBe(true)
    // Unresolvable from the file, so it fails closed rather than reading as safe.
    expect(couldRunOnWindows('${{ matrix.os }}')).toBe(true)
    expect(couldRunOnWindows('ubuntu-latest')).toBe(false)
    expect(couldRunOnWindows(['self-hosted', 'linux'])).toBe(false)
    expect(couldRunOnWindows(undefined)).toBe(false)
  })
})

describe('Windows-gate detection', () => {
  // Each positive is paired with the near-miss it must reject. The pairs are
  // written from the shapes that exist in the repo, not from the regexes above.
  const cases = [
    [
      'describe.runIf equality',
      "describe.runIf(process.platform === 'win32')('x', () => {})",
      "describe.runIf(process.platform !== 'win32')('x', () => {})"
    ],
    [
      'describe.skipIf inequality',
      "describe.skipIf(process.platform !== 'win32')('x', () => {})",
      "describe.skipIf(process.platform === 'win32')('x', () => {})"
    ],
    [
      'ternary describe alias',
      "const d = process.platform === 'win32' ? describe : describe.skip",
      "const d = process.platform === 'win32' ? describe.skip : describe"
    ],
    [
      'inverted ternary describe alias',
      "const d = process.platform !== 'win32' ? describe.skip : describe",
      "const d = process.platform !== 'win32' ? describe : describe.skip"
    ],
    [
      'local isWindows flag',
      "const isWindows = process.platform === 'win32'\ndescribe.skipIf(!isWindows)('x', () => {})",
      "const isWindows = process.platform === 'win32'\ndescribe.skipIf(isWindows)('x', () => {})"
    ],
    [
      'local isWindows flag, runIf',
      "const isWindows = process.platform === 'win32'\ndescribe.runIf(isWindows)('x', () => {})",
      "const isWindows = process.platform === 'win32'\ndescribe.runIf(!isWindows)('x', () => {})"
    ],
    [
      // The blocking miss: a second conjunct made the gate invisible.
      'compound gate with a second conjunct',
      "describe.runIf(process.platform === 'win32' && Boolean(distro))('x', () => {})",
      "describe.runIf(process.platform === 'win32' || Boolean(distro))('x', () => {})"
    ],
    [
      'compound gate behind a named flag assigned on the next line',
      "const RUN_REAL =\n  process.platform === 'win32' && process.env.X === '1'\ndescribe.runIf(RUN_REAL)('x', () => {})",
      "const RUN_REAL =\n  process.platform !== 'win32' && process.env.X === '1'\ndescribe.runIf(RUN_REAL)('x', () => {})"
    ],
    [
      'named flag driving a ternary suite alias',
      "const enabled = process.platform === 'win32' && process.env.X === '1'\nconst d = enabled ? describe : describe.skip",
      "const enabled = process.platform === 'win32' && process.env.X === '1'\nconst d = enabled ? describe.skip : describe"
    ],
    [
      'compound skipIf widened with ||',
      "describe.skipIf(process.platform !== 'win32' || !hasAddon)('x', () => {})",
      "describe.skipIf(process.platform !== 'win32' && !hasAddon)('x', () => {})"
    ],
    [
      'double-quoted and loosely spaced',
      'describe . runIf ( process.platform === "win32" )("x", () => {})',
      'describe . runIf ( process.platform === "darwin" )("x", () => {})'
    ]
  ]

  for (const [label, gated, nearMiss] of cases) {
    it(`detects ${label} and rejects its near miss`, () => {
      expect(isWindows32GatedTestFile('src/x/sample.test.ts', gated)).toBe(true)
      expect(isWindows32GatedTestFile('src/x/sample.test.ts', nearMiss)).toBe(false)
    })
  }

  it('detects the .win32 filename with no gate expression at all', () => {
    expect(isWindows32GatedTestFile('src/x/sample.win32.test.ts', 'describe("x", () => {})')).toBe(
      true
    )
    // Near miss: `.win32.ts` is production source, not a test the lane can run.
    expect(isWindows32GatedTestFile('src/x/sample.win32.ts', 'export const x = 1')).toBe(false)
  })

  it('does not read a flag whose name merely starts the same', () => {
    // Without word boundaries `isWindows` would swallow `isWindowsHost`.
    expect(
      isWindows32GatedTestFile(
        'src/x/sample.test.ts',
        "const isWindows = process.platform === 'win32'\ndescribe.runIf(isWindowsHost)('x', () => {})"
      )
    ).toBe(false)
  })

  it('rejects the documented blind spots rather than half-detecting them', () => {
    // it-level gate inside a cross-platform suite: out of scope by design.
    expect(
      isWindows32GatedTestFile(
        'src/x/sample.test.ts',
        "describe('x', () => { it.skipIf(process.platform !== 'win32')('y', () => {}) })"
      )
    ).toBe(false)
    // A platform branch inside a test body is not a gate.
    expect(
      isWindows32GatedTestFile(
        'src/x/sample.test.ts',
        "it('x', () => { if (process.platform === 'win32') { return } })"
      )
    ).toBe(false)
    // An imported flag: the assignment is not in this file, so polarity is unknowable.
    expect(
      isWindows32GatedTestFile(
        'src/x/sample.test.ts',
        "import { isWindows } from './f'\ndescribe.runIf(isWindows)('x', () => {})"
      )
    ).toBe(false)
  })

  it('does not treat a widening conjunct behind a named flag as Windows-only', () => {
    // `!== 'win32' && x` skips only when BOTH hold, so the suite runs on
    // Windows and on POSIX when `x` is false. The literal form is rejected by
    // the `||` pair above; this is the same condition routed through a flag,
    // which is where the shared lookahead used to flip the answer.
    expect(
      isWindows32GatedTestFile(
        'src/x/sample.test.ts',
        "const p = process.platform !== 'win32' && Boolean(x)\ndescribe.skipIf(p)('x', () => {})"
      )
    ).toBe(false)
    // The narrowing direction still counts: `=== 'win32' && x` is Windows-only.
    expect(
      isWindows32GatedTestFile(
        'src/x/sample.test.ts',
        "const p = process.platform === 'win32' && Boolean(x)\ndescribe.runIf(p)('x', () => {})"
      )
    ).toBe(true)
  })

  it('ignores a gate that only appears in prose', () => {
    expect(
      isWindows32GatedTestFile(
        'src/x/sample.test.ts',
        "// describe.runIf(process.platform === 'win32')\ndescribe('x', () => {})"
      )
    ).toBe(false)
  })
})
