#!/usr/bin/env node
// Repo hygiene check — keeps machine-specific content out of the public tree.
//
// The failure this prevents: a path like a home-directory checkout or a
// personal name in a comment looks harmless on the machine that wrote it, and
// breaks or embarrasses everyone else. It is also invisible in review, so it
// needs to be checked mechanically.
//
// Usage:
//   node scripts/check-repo-hygiene.mjs [repo] [--lib] [--strict] [--patterns-file <path>]
//
// Exit codes: 0 = clean, 1 = findings, 2 = usage error.
//
// Deployment-specific terms (internal project names, personal forms of
// address, private hostnames) are NOT listed here — this file ships publicly,
// so a list of the terms would itself be the leak. Put them in a local file
// and pass it in; .leak-patterns is gitignored for exactly this.
//   node scripts/check-repo-hygiene.mjs . --lib --patterns-file ../.leak-patterns
// or export REPO_HYGIENE_PATTERNS=/path/to/patterns.

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { join, relative, extname, resolve } from "node:path"

// Universal "you shipped your machine" signals.
const BASE_PATTERNS = [
  // Absolute paths into somebody's home directory.
  [/\/home\/[A-Za-z0-9._-]+\//, "absolute home path"],
  [/\/root\//, "root home path"],
  [/\/Users\/[A-Za-z0-9._-]+\//, "macOS home path"],
  [/\/mnt\/[a-z]\//, "WSL mount path"],
  // A Windows profile path. The backslashes are written one or two per
  // separator: a path in a source file usually has single ones, while a
  // path in a string literal that itself escapes them has doubled ones.
  // Matching only the doubled form left the plain form unreported, which
  // is the form a real path actually takes.
  [/[A-Za-z]:\\+(?:Users|Projects?|Documents|Desktop)\\+/i, "Windows user path"],
  // Credentials pasted into source.
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/, "GitHub token"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/, "GitHub fine-grained token"],
  [/\bsk-[A-Za-z0-9_-]{20,}/, "API key"],
  [/\bAKIA[0-9A-Z]{16}\b/, "AWS access key"],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/, "Slack token"],
]

// Documentation and tests legitimately spell out placeholder paths
// (a home directory under a generic user name, a WSL mount under a
// bracketed stand-in). Flagging those trains people
// to ignore the check, so placeholders are skipped.
// Segments that may follow a WSL mount prefix and still be a stand-in.
// Deliberately narrow: a real path under a WSL mount must be reported.
const WSL_PROFILE_SEGMENTS = new Set(["<win-user>", "<username>", "<user>", "user", "username"])

const PLACEHOLDER_USERS = new Set([
  "user", "username", "yourname", "your-user", "youruser", "you", "me",
  "example", "test", "foo", "bar", "baz", "someone", "somebody",
  "project", "projects", "home", "name", "x", "xxx",
  // Generic stand-ins that appear inside paths in documentation and tests.
  // "win-user" is the one used for the Windows profile directory in this
  // project's own examples; without it the examples read as real paths.
  "win-user", "winuser", "windows-user", "<win-user>", "dsh",
])

// A line is exempt from a pattern only when the match itself sits inside a
// placeholder — not when the line merely contains an angle bracket.
//
// The earlier rule ("any line containing < or > is a placeholder") was far
// too broad: it exempted the whole line from every pattern whenever the
// line contained an arrow (=> or ->), a generic type parameter (<T>), a
// comparison (a < b), an HTML tag, or a markdown quote marker (> ). That is
// a structural blind spot, not a placeholder allowance: in the CI-covered
// files, 7.9% of all non-empty lines contain an angle bracket, and a real
// leak sitting on any of them was never reported. A quoted markdown line
// that mentioned a private term was never caught either, because the whole
// line was skipped.
function placeholderSpans(line) {
  const spans = []
  for (const m of line.matchAll(/<([^<>\n]{1,64})>/g)) {
    const inner = m[1].trim().toLowerCase()
    if (PLACEHOLDER_USERS.has(inner)) spans.push({ start: m.index, end: m.index + m[0].length })
  }
  return spans
}

function isPlaceholderMatch(line, matchIndex, matchLength) {
  // The match is exempt when it falls inside a placeholder span.
  for (const span of placeholderSpans(line)) {
    if (matchIndex >= span.start && matchIndex + matchLength <= span.end) return true
  }
  // The second allowance: a home-directory path whose user segment is a
  // well-known placeholder name (/home/user/..., /Users/<you>/...).
  //
  // This is judged on the matched text itself, not on where the match sits:
  // the pattern for an absolute home path matches "/home/user/" including
  // the user segment, so the whole match is the placeholder.
  const matched = line.slice(matchIndex, matchIndex + matchLength)
  // The user segment of a home path. The pattern matches "/home/" plus the
  // user segment, so the segment is inside the matched text.
  const seg = matched.match(/(?:\/home\/|\/Users\/)([A-Za-z0-9._-]+)/i)
  if (seg && PLACEHOLDER_USERS.has(seg[1].toLowerCase())) return true
  // The Windows form is different: the pattern matches only the
  // directory, so the user segment sits just after the match, on the
  // line. Look for it there.
  // The user segment may be spelled with angle brackets — `<win-user>` is
  // one of the stand-ins this gate exempts, and the bracket form was
  // unreachable here: the character class stopped at the bracket, so the
  // segment read as empty and the placeholder path was reported as a real
  // one. The bracketed form is captured whole.
  const win = line.slice(matchIndex).match(/^[A-Za-z]:\\+[A-Za-z]+\\+(<[^>]+>|[A-Za-z0-9._-]+)/i)
  if (win) {
    const seg = win[1].toLowerCase()
    // A bracketed segment is a stand-in whatever it is called: the
    // brackets are the statement, and the name list below is only for
    // the unbracketed form. Judging "<username>" against that list
    // reported a placeholder path as a real one, because the list held
    // one bracketed name and not the other.
    if (/^<.+>$/.test(seg)) return true
    if (PLACEHOLDER_USERS.has(seg)) return true
  }
  // The same allowance for a WSL mount: /mnt/c/<win-user>/... is a generic
  // Windows profile directory, not a real path.
  //
  // The user segment is read at the position of THIS match, not from the
  // line. Reading it from the line exempted the whole line whenever any
  // WSL path on it had a placeholder in it — so a line that copied from a
  // placeholder profile directory and also named a real project directory
  // passed as clean, and the real path in it was never reported.
  //
  // The generic PLACEHOLDER_USERS list is deliberately NOT used here: it
  // contains words like "project" and "name", and a real path under a
  // mount is not a stand-in. Only a bracketed segment counts, or one of
  // the names a WSL profile directory plausibly takes.
  const wsl = line.slice(matchIndex).match(/^\/mnt\/[a-z]\/([^/\n]+)/i)
  if (wsl) {
    const seg = wsl[1].trim().toLowerCase()
    const bracketed = /^<.+>$/.test(seg)
    if (bracketed || WSL_PROFILE_SEGMENTS.has(seg)) return true
  }
  return false
}

const SCAN_EXT = new Set([".md", ".yml", ".yaml", ".mjs", ".js", ".ts", ".tsx", ".py", ".json", ".sh", ".txt", ".toml"])
const DEFAULT_DIRS = ["src", "tests", "docs", "scripts", ".github", "config", "bin", "journey", "promo"]
const NON_STRICT_DIRS = ["src", "tests", "docs", "scripts"]
const SKIP_DIRS = new Set([".git", "node_modules", "__pycache__", "dist", "build", "coverage"])

// The files that would actually be published.
//
// The check used to walk the working tree, which meant it also read the
// local-only files that .gitignore keeps out of the repository — the
// deployment scripts on this host, which name this host's service unit
// and its directories. Those files never ship, so flagging them was
// wrong twice over: it reported findings on content that is not
// published, and it forced a local script that has to work here to be
// rewritten into something that would not.
//
// The set of published files is what git tracks. Listing them is also
// exact, where walking directories has to guess: a file in a directory
// nobody scanned was invisible, and the repository root was not in the
// list of scanned directories at all.
//
// Falls back to walking when git is unavailable or the directory is not
// a repository, so the check still runs somewhere it cannot ask git.
function trackedFiles(repo) {
  try {
    const out = execFileSync("git", ["-C", repo, "ls-files", "-z"], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      // git prints "fatal: not a git repository" on stderr when the
      // directory is not one; that noise does not belong in the check's
      // output.
      stdio: ["ignore", "pipe", "ignore"],
    })
    const files = out.split("\0").filter(Boolean)
    if (files.length) return files
  } catch {
    // fall through to the walk
  }
  return null
}

function parseArgs(argv) {
  const args = { repo: ".", lib: false, strict: false, patternsFile: null }
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--lib") args.lib = true
    else if (a === "--strict") args.strict = true
    else if (a === "--patterns-file") args.patternsFile = argv[++i]
    else if (a.startsWith("--")) throw new Error(`unknown flag: ${a}`)
    else positional.push(a)
  }
  if (positional.length) args.repo = positional[0]
  return args
}

function loadLocalPatterns(file) {
  if (!file || !existsSync(file)) return []
  return readFileSync(file, "utf8")
    .split("\n")
    .map(l => l.replace(/\s+#.*$/, "").trim()) // allow trailing comments
    .filter(l => l && !l.startsWith("#"))
    .map(l => {
      try {
        return [new RegExp(l), `local pattern: ${l}`]
      } catch {
        console.error(`  warning: skipping invalid regex in ${file}: ${l}`)
        return null
      }
    })
    .filter(Boolean)
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) walk(full, out)
    else if (SCAN_EXT.has(extname(name))) out.push(full)
  }
  return out
}

function scanFile(repo, file, patterns, hits) {
  let content
  try {
    content = readFileSync(file, "utf8")
  } catch {
    return
  }
  const lines = content.split("\n")
  for (const [re, label] of patterns) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      // Every occurrence on the line is looked at, not just the first.
      // Taking only the first match meant a line whose first occurrence
      // was exempt — a placeholder earlier on the line — was skipped
      // whole, so a real path later on that same line went unreported.
      const flags = re.flags.includes("g") ? re.flags : re.flags + "g"
      const rx = new RegExp(re.source, flags)
      let m
      let reported = false
      while ((m = rx.exec(line)) !== null) {
        if (m[0].length === 0) {
          rx.lastIndex++
          continue
        }
        if (!isPlaceholderMatch(line, m.index, m[0].length)) {
          hits.push({ path: relative(repo, file), line: i + 1, label, text: line.trim().slice(0, 120) })
          reported = true
          break
        }
        rx.lastIndex = m.index + m[0].length
      }
      if (reported) break
    }
  }
}

function main() {
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (e) {
    console.error(`usage: check-repo-hygiene.mjs [repo] [--lib] [--strict] [--patterns-file <path>]\n  ${e.message}`)
    return 2
  }
  const repo = resolve(args.repo)
  if (!existsSync(repo) || !statSync(repo).isDirectory()) {
    console.error(`not a directory: ${repo}`)
    return 2
  }

  const patternsFile = args.patternsFile || process.env.REPO_HYGIENE_PATTERNS
  const patterns = [...BASE_PATTERNS, ...loadLocalPatterns(patternsFile)]
  const dirs = args.strict ? DEFAULT_DIRS : NON_STRICT_DIRS

  console.log(`checking ${repo}`)
  if (patternsFile && existsSync(patternsFile)) console.log(`  + local patterns from ${patternsFile}`)

  const hits = []
  const tracked = trackedFiles(repo)
  if (tracked) {
    // Exactly the files that ship. This covers the repository root — where
    // the package's own manifest, README and bundle configuration live,
    // and which used to be invisible because the scan walked a fixed list
    // of directories that did not include the root — and it leaves out the
    // local-only files that .gitignore keeps out of the repository.
    let scanned = 0
    for (const rel of tracked) {
      if (!SCAN_EXT.has(extname(rel))) continue
      const full = join(repo, rel)
      if (!existsSync(full)) continue
      scanFile(repo, full, patterns, hits)
      scanned++
    }
    console.log(`  scanned ${scanned} tracked file(s)`)
  } else {
    // No git here: walk the directories, including the root, so the check
    // still reports something rather than pretending to be clean.
    //
    // The walk covers the full default set, not the reduced one. The
    // reduced set belongs to the git path, where the file list is already
    // exact; here the directories are the only thing known, and narrowing
    // them meant a repository whose git could not be asked (dubious
    // ownership, a checkout owned by another user) was checked in four
    // directories, missed a real leak in another one, and reported itself
    // clean.
    for (const d of DEFAULT_DIRS) {
      const base = join(repo, d)
      if (!existsSync(base) || !statSync(base).isDirectory()) continue
      for (const f of walk(base, [])) scanFile(repo, f, patterns, hits)
    }
    for (const name of readdirSync(repo)) {
      if (SKIP_DIRS.has(name)) continue
      const full = join(repo, name)
      let st
      try {
        st = statSync(full)
      } catch {
        continue
      }
      if (st.isFile() && SCAN_EXT.has(extname(name))) scanFile(repo, full, patterns, hits)
    }
    console.log(`  git could not list the tracked files — walked ${DEFAULT_DIRS.length} directories instead`)
  }
  // Build output ships to npm, so it is scanned too — but only when asked,
  // since a minified bundle legitimately contains long opaque strings.
  if (args.lib) {
    const lib = join(repo, "lib")
    // existsSync covers the directory itself; walk() needs the guard too,
    // because a repository without a lib/ directory made the scan throw
    // ENOENT and the check died instead of reporting.
    if (existsSync(lib) && statSync(lib).isDirectory()) {
      for (const f of walk(lib, [])) scanFile(repo, f, patterns, hits)
    }
  }

  if (!hits.length) {
    console.log("clean: no machine-specific content found")
    return 0
  }
  console.log(`found ${hits.length} finding(s):`)
  for (const h of hits) console.log(`  ${h.path}:${h.line}  [${h.label}]  ${h.text}`)
  return 1
}

process.exit(main())
