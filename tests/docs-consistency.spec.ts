import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

/**
 * The documentation gate is a script; a script nobody runs on purpose is a
 * script that only runs when something else breaks. These tests keep the
 * gate honest from both sides: it passes on the repository as it stands,
 * and it still catches each kind of drift it is there to catch.
 */
const ROOT = path.resolve(import.meta.dirname ?? '.', '..')
const GATE = path.join(ROOT, 'scripts', 'check-docs-consistency.mjs')

function runGate() {
  try {
    const stdout = execFileSync('node', [GATE], { cwd: ROOT, encoding: 'utf8' })
    return { code: 0, stdout }
  } catch (error) {
    const e = error as { status?: number, stdout?: string }
    return { code: e.status ?? 1, stdout: e.stdout ?? '' }
  }
}

function withFile(relative: string, change: (text: string) => string, assertion: () => void) {
  const file = path.join(ROOT, relative)
  const original = fs.readFileSync(file, 'utf8')
  try {
    fs.writeFileSync(file, change(original), 'utf8')
    assertion()
  } finally {
    fs.writeFileSync(file, original, 'utf8')
  }
}

describe('the documentation gate', () => {
  it('passes on the repository as it stands', () => {
    const result = runGate()
    expect(result.stdout).toContain('documentation is in step with the code')
    expect(result.code).toBe(0)
  })

  it('catches a test count that no longer matches', () => {
    // The number is not written down here on purpose: the badge moves every
    // time a test is added, and a test that replaces one fixed number
    // silently stops replacing anything once the badge has moved past it.
    withFile('README.md', (text) => text.replace(/tests-\d+%20passing/, 'tests-1%20passing'), () => {
      const result = runGate()
      expect(result.code).not.toBe(0)
      expect(result.stdout).toContain('test count')
    })
  })

  it('catches a command that is written down but does not exist', () => {
    withFile('README.md', (text) => `${text}\n| \`/nosuchcommand\` | Does not exist |\n`, () => {
      const result = runGate()
      expect(result.code).not.toBe(0)
      expect(result.stdout).toContain('lists no command that does not exist')
    })
  })

  it('catches a command the bridge implements but no README mentions', () => {
    withFile('README.md', (text) => text.replace('| `/tools` |', '| `/tools` |'), () => {
      // Remove the row entirely rather than rewriting it.
      const original = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8')
      const without = original
        .split('\n')
        .filter((line) => !line.startsWith('| `/tools` |'))
        .join('\n')
      fs.writeFileSync(path.join(ROOT, 'README.md'), without, 'utf8')
      try {
        const result = runGate()
        expect(result.code).not.toBe(0)
        expect(result.stdout).toContain('documents every command the bridge implements')
      } finally {
        fs.writeFileSync(path.join(ROOT, 'README.md'), original, 'utf8')
      }
    })
  })

  it('catches the manual and the chat copy of it drifting apart', () => {
    withFile('docs/\u7528\u6237\u624b\u518c.md', (text) => text.replace('\u53cd\u9988\uff1a`/feedback`', '\u53cd\u9988\uff1a`/feedback`\uff08\u53e6\u52a0\u4e00\u53e5\uff09'), () => {
      const result = runGate()
      expect(result.code).not.toBe(0)
      expect(result.stdout).toContain('agree')
    })
  })
})
