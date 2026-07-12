#!/usr/bin/env node
// pre_close_check.mjs — the session-close gate. Run AFTER the session's
// final commit, from anywhere inside the repo/worktree being closed:
//
//   node .claude/skills/session-close/scripts/pre_close_check.mjs \
//        [--base <ref>] [--decisions-approved "<who/what approved it>"] \
//        [--allow-dirty "<path>: <reason>"]...
//
// It verifies, in order:
//   1. `npm run check-local` is green RIGHT NOW — run fresh, not remembered
//   2. git status is clean — at close, an uncommitted or untracked file is
//      either unfinished session work or a foreign change; both are failures.
//      Exception: a path declared with --allow-dirty (repeatable) may be
//      dirty or untracked — founder-declared in the session prompt, echoed
//      into the summary with its reason. ANY other dirty state still fails;
//      no flag, no exception (the --decisions-approved design).
//   3. every JUDGMENT: mark added in the session diff (merge-base with
//      --base, default origin/main, to HEAD) is collected and listed for
//      the close report
//   4. docs/DECISIONS.md was not changed in the session diff unless
//      --decisions-approved records what founder approval covers it
// then prints a summary block to paste into the close report.
//
// Exit 0 = green, 1 = a check failed, 2 = usage/environment error.

import { execFileSync, spawnSync } from "node:child_process";
import { basename } from "node:path";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const flags = (name) =>
  args.flatMap((a, i) => (a === name && args[i + 1] !== undefined ? [args[i + 1]] : []));
const base = flag("--base") ?? "origin/main";
const decisionsApproved = flag("--decisions-approved");
// JUDGMENT: the ruled form is "<path>: <reason>"; a value with no colon is
// tolerated as a bare path and echoed as "(no reason given)" rather than
// rejected — the gate's job is refusing undeclared state, not lexing.
const allowDirty = flags("--allow-dirty").map((v) => {
  const i = v.indexOf(":");
  return i === -1
    ? { path: v.trim(), reason: "(no reason given)" }
    : { path: v.slice(0, i).trim(), reason: v.slice(i + 1).trim() || "(no reason given)" };
});

const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  cwd: import.meta.dirname,
  encoding: "utf8",
}).trim();
const git = (...a) => execFileSync("git", a, { cwd: repoRoot, encoding: "utf8" }).trim();

const failures = [];

// --- 1. check-local, fresh -----------------------------------------------
// Constant, hard-coded command; shell:true only because npm is npm.cmd on
// Windows. No user input reaches this invocation.
console.log("pre-close: running npm run check-local (fresh — a stale green is a red)…");
const run = spawnSync("npm", ["run", "check-local"], {
  cwd: repoRoot,
  shell: true,
  encoding: "utf8",
  maxBuffer: 32 * 1024 * 1024,
});
const harnessOut = `${run.stdout ?? ""}${run.stderr ?? ""}`;
const tally = harnessOut.match(/(\d+) passed, (\d+) failed\./);
const checkLocal =
  run.status === 0 && tally
    ? `green (${tally[1]} passed, ${tally[2]} failed)`
    : `RED (exit ${run.status}${tally ? `; ${tally[1]} passed, ${tally[2]} failed` : ""})`;
if (run.status !== 0) {
  failures.push("check-local is not green — Gate 1 fails, the session cannot close on this state");
  process.stdout.write(harnessOut); // the evidence, in full, when it fails
}

// --- 2. clean tree (up to founder-declared --allow-dirty paths) --------------
// Raw, untrimmed: the XY status prefix is positional, and the git() helper's
// trim() would eat a significant leading space on the FIRST line (" M path"),
// shifting slice(3) off the path.
const porcelain = execFileSync("git", ["status", "--porcelain"], {
  cwd: repoRoot,
  encoding: "utf8",
});
const statusPath = (line) => {
  // porcelain v1: "XY path" or "XY old -> new"; quoted when exotic
  let p = line.slice(3);
  const arrow = p.indexOf(" -> ");
  if (arrow !== -1) p = p.slice(arrow + 4);
  if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
  return p;
};
const dirtyLines = porcelain.split("\n").filter((l) => l.length > 0);
const undeclaredDirty = dirtyLines.filter(
  (l) => !allowDirty.some((a) => a.path === statusPath(l))
);
if (undeclaredDirty.length) {
  failures.push(
    "git status is not clean — uncommitted session work or foreign changes (undeclared):\n" +
      undeclaredDirty.map((l) => `        ${l}`).join("\n")
  );
}

// --- 3. JUDGMENT marks in the session diff ----------------------------------
let mergeBase;
try {
  mergeBase = git("merge-base", base, "HEAD");
} catch {
  console.error(`Cannot resolve --base "${base}" — pass a ref that exists (e.g. origin/main).`);
  process.exit(2);
}
const diff = git("diff", `${mergeBase}..HEAD`);
const judgments = [];
let currentFile = "?";
for (const line of diff.split("\n")) {
  const fileMark = line.match(/^\+\+\+ b\/(.+)$/);
  if (fileMark) currentFile = fileMark[1];
  if (/^\+/.test(line) && !line.startsWith("+++")) {
    const m = line.match(/JUDGMENT:\s*(.*)/);
    if (m) judgments.push({ file: currentFile, text: m[1].trim() || "(no rationale on the line)" });
  }
}

// --- 4. DECISIONS.md needs recorded approval ---------------------------------
const changedFiles = git("diff", "--name-only", `${mergeBase}..HEAD`).split("\n").filter(Boolean);
const decisionsChanged = changedFiles.includes("docs/DECISIONS.md");
if (decisionsChanged && !decisionsApproved) {
  failures.push(
    "docs/DECISIONS.md changed in this session with no approval noted — it is written only " +
      'after Mudassir approves. If approval is on record, re-run with --decisions-approved "<what covers it>".'
  );
}

// --- summary block ------------------------------------------------------------
const branch = git("rev-parse", "--abbrev-ref", "HEAD");
const head = git("rev-parse", "--short", "HEAD");
console.log("\n--- pre-close summary (paste into the close report) ---------------");
console.log(`check-local:    ${checkLocal}`);
console.log(
  `git status:     ${
    dirtyLines.length === 0
      ? "clean"
      : undeclaredDirty.length === 0
        ? `clean up to ${dirtyLines.length} declared dirty path(s)`
        : "DIRTY (undeclared state present)"
  }`
);
for (const a of allowDirty) console.log(`  allow-dirty:  ${a.path} — ${a.reason}`);
console.log(`branch:         ${branch} @ ${head}   (session diff: ${base} → HEAD, ${changedFiles.length} file(s))`);
console.log(
  `JUDGMENT marks: ${judgments.length ? "" : "none in the session diff"}`
);
for (const j of judgments) console.log(`  - ${j.file}: ${j.text}`);
console.log(
  `DECISIONS.md:   ${
    decisionsChanged
      ? decisionsApproved
        ? `changed — approval noted: ${decisionsApproved}`
        : "changed — NO APPROVAL NOTED"
      : "untouched"
  }`
);
console.log("--------------------------------------------------------------------");

if (failures.length) {
  console.error(`\npre-close: ${failures.length} check(s) failed\n`);
  for (const f of failures) console.error(`  FAIL  ${f}`);
  console.error("\nThe books do not balance; the session does not close on this state.");
  process.exit(1);
}
console.log("\npre-close: green — the books balance.");
