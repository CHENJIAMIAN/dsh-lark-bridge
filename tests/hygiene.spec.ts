import { describe, it, expect } from "vitest"
import { execFileSync } from "node:child_process"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..")
const CHECK = join(REPO, "scripts/check-repo-hygiene.mjs")

// Fixture strings are assembled at runtime rather than written literally:
// this file is itself inside the scanned tree, so a literal sample path would
// be reported by the very check it is testing.
const F = (...parts: string[]) => parts.join("")
const WSL_PATH = F("/mnt/", "d/PROJECT/real/lib")
const HOME_PATH = F("/home/", "realuser/work/x")
const FAKE_TOKEN = F("ghp_", "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")
const PRIVATE_TERM = F("Internal", "ProjectCodename")

/** Run the checker and return its exit code — the contract is the exit code,
 *  so it must not be swallowed by a pipe. */
function runCheck(args: string[]): number {
  try {
    execFileSync("node", [CHECK, ...args], { stdio: "pipe" })
    return 0
  } catch (e) {
    return (e as { status?: number }).status ?? -1
  }
}

function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "hygiene-"))
  for (const [rel, body] of Object.entries(files)) {
    const full = join(dir, rel)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, body)
  }
  return dir
}

/** A fixture that is a git repository, with the given files committed. */
function withGitFixture(files: Record<string, string>, fn: (dir: string) => void) {
  const dir = fixture(files)
  try {
    execFileSync("git", ["init", "-q", "."], { cwd: dir, stdio: "pipe" })
    execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: dir, stdio: "pipe" })
    execFileSync("git", ["config", "user.name", "test"], { cwd: dir, stdio: "pipe" })
    execFileSync("git", ["add", "-A"], { cwd: dir, stdio: "pipe" })
    execFileSync("git", ["commit", "-qm", "fixture"], { cwd: dir, stdio: "pipe" })
    fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function withFixture(files: Record<string, string>, fn: (dir: string) => void) {
  const dir = fixture(files)
  try {
    fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe("repo hygiene check", () => {
  // The check reads the files git tracks, because those are the files that
  // ship. A local-only file that .gitignore keeps out of the repository
  // never leaves this machine, so a machine path in it is not a leak —
  // and flagging it would force a script that has to work here to be
  // rewritten into something that would not.
  describe("which files it reads", () => {
    it("reports a leak in a tracked file", () => {
      withGitFixture({ "src/a.ts": `const LIB = "${WSL_PATH}"` }, dir => {
        expect(runCheck([dir])).toBe(1)
      })
    })

    it("does not report a leak in an untracked file", () => {
      withGitFixture({ "src/a.ts": "export const ok = 1" }, dir => {
        // written after the commit, so it is present in the working tree
        // but not tracked
        writeFileSync(join(dir, "src/local-only.ts"), `const LIB = "${WSL_PATH}"`)
        expect(runCheck([dir])).toBe(0)
      })
    })
  })

  // Uses the operator's own patterns when present, so this asserts the same
  // thing CI does rather than a weaker subset.
  it("passes on this repository", () => {
    const local = join(REPO, ".leak-patterns")
    const args = [REPO, "--lib"]
    if (existsSync(local)) args.push("--patterns-file", local)
    expect(runCheck(args)).toBe(0)
  })

  it("reports a real WSL mount path", () => {
    withFixture({ "src/a.ts": `const LIB = "${WSL_PATH}"` }, dir => {
      expect(runCheck([dir])).toBe(1)
    })
  })

  it("reports a real home path", () => {
    withFixture({ "src/a.ts": `const h = "${HOME_PATH}"` }, dir => {
      expect(runCheck([dir])).toBe(1)
    })
  })

  it("reports a pasted credential", () => {
    withFixture({ "src/a.ts": `const t = "${FAKE_TOKEN}"` }, dir => {
      expect(runCheck([dir])).toBe(1)
    })
  })

  // A Windows path is written with one backslash per separator in a source
  // file, and with two when the string literal itself escapes them. Both
  // spellings are a real path, and both have to be reported — matching only
  // the doubled form left the plain form unreported, which is the form a
  // real path actually takes.
  it("reports a real Windows path in either spelling", () => {
    const plain = 'const p = "C:' + "\\" + 'Users' + "\\" + 'realuser' + "\\" + 'docs"'
    const escaped = 'const p = "C:' + "\\\\" + 'Users' + "\\\\" + 'realuser' + "\\\\" + 'docs"'
    for (const body of [plain, escaped]) {
      withFixture({ "src/a.ts": body }, dir => {
        expect(runCheck([dir])).toBe(1)
      })
    }
  })

  it("does not report a Windows path under a placeholder user name", () => {
    const body = 'const p = "C:' + "\\" + 'Users' + "\\" + 'username' + "\\" + 'docs"'
    withFixture({ "src/a.ts": body }, dir => {
      expect(runCheck([dir])).toBe(0)
    })
  })

  // A bracketed stand-in is a stand-in whatever it is called. The list of
  // placeholder names held one bracketed entry and not the other, so a
  // bracketed name that was not on the list was reported as a real path —
  // a false alarm on a path that says on its face that it is an example.
  it("does not report a Windows path under a bracketed placeholder", () => {
    for (const stand in ["username", "win-user", "your-name"]) {
      const body = 'const p = "C:' + "\\" + 'Users' + "\\" + '<' + stand + '>' + "\\" + 'docs"'
      withFixture({ "src/a.ts": body }, dir => {
        expect(runCheck([dir])).toBe(0)
      })
    }
  })

  // When git cannot list the tracked files the check falls back to walking
  // directories. That fallback used to walk the reduced directory set,
  // which left the configuration directory unchecked — so a real leak
  // there went unreported and the check called the tree clean.
  it("reports a leak in a configuration file when git cannot list the files", () => {
    withFixture({ "config/leak.yaml": `token: ${FAKE_TOKEN}` }, dir => {
      expect(runCheck([dir])).toBe(1)
    })
  })

  // A placeholder earlier on a line does not exempt the rest of the line.
  // The check used to look at the first match of a pattern on a line, so
  // a line whose first occurrence was a placeholder was skipped whole —
  // and a real path later on that same line went unreported.
  it("reports a real path that follows a placeholder on the same line", () => {
    // The fixture strings are assembled rather than written literally:
    // this file is itself inside the scanned tree.
    const body = `cp ${F("/mnt/", "c/username/x")} /tmp ${WSL_PATH}`
    withFixture({ "src/a.ts": body }, dir => {
      expect(runCheck([dir])).toBe(1)
    })
  })

  // Docs and tests spell out placeholder paths on purpose. Flagging them
  // teaches everyone to ignore the check, which is worse than not having one.
  it("does not report placeholder paths", () => {
    withFixture(
      {
        "src/a.ts": [
          'const p = "/home/user/project-a"',
          'const q = "/mnt/c/<win-user>/.dsh"',
          'const r = "C:\\\\Users\\\\username\\\\docs"',
        ].join("\n"),
      },
      dir => {
        expect(runCheck([dir])).toBe(0)
      },
    )
  })

  // Deployment-specific terms must stay out of this repo, so they arrive as a
  // local patterns file rather than a hardcoded list.
  it("applies terms from a local patterns file", () => {
    withFixture({ "src/a.ts": `const o = "${PRIVATE_TERM}"`, ".leak-patterns": `${PRIVATE_TERM}\n` }, dir => {
      expect(runCheck([dir, "--patterns-file", join(dir, ".leak-patterns")])).toBe(1)
      expect(runCheck([dir])).toBe(0)
    })
  })

  it("exits 2 on an unknown flag", () => {
    expect(runCheck([REPO, "--bogus"])).toBe(2)
  })
})
