#!/usr/bin/env node
// check_migration.mjs — lint migrations against the migration-discipline
// non-negotiables. Reports findings; NEVER fixes anything.
//
// Usage:
//   node check_migration.mjs <migration.sql> [...more.sql]   lint the named files
//   node check_migration.mjs                                 lint every migration
//                                                            in packages/db/migrations
//
// Checks, per file:
//   1. every CREATE TABLE has RLS enabled in the same migration
//   2. no DELETE policy reachable by users (authenticated/anon/public)
//   3. JUDGMENT: comments are well-formed (`-- JUDGMENT: <rationale>`)
// Checks, always (via git):
//   4. no previously committed migration has been edited — a migration in
//      HEAD whose working-tree or staged content differs is reported.
//      Boundary: this sees uncommitted edits; an edit already buried in an
//      earlier commit is history and belongs to review, not to this lint.
//
// Exit 0 = green, 1 = findings, 2 = usage/environment error.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, basename } from "node:path";
import { execFileSync } from "node:child_process";

// JUDGMENT: the Session 1 scaffold (PLAYBOOK §6.1's founding exception)
// created tables in 0002–0011 and enabled RLS for all of them in 0012;
// the same-migration rule dates from after that. These files pass check 1
// if their tables' RLS lives in 0012_rls.sql — verified there, not assumed.
// New migrations get the strict rule, no additions to this list.
const FOUNDING_EXCEPTION_FILES = new Set([
  "0002_platform_and_actors.sql",
  "0003_template_configuration.sql",
  "0004_events.sql",
  "0005_contacts.sql",
  "0006_engagements.sql",
  "0007_tasks.sql",
  "0008_communications.sql",
  "0009_content.sql",
  "0010_money.sql",
  "0011_files_and_links.sql",
]);
const FOUNDING_RLS_FILE = "0012_rls.sql";

const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  cwd: import.meta.dirname,
  encoding: "utf8",
}).trim();
const migrationsDir = resolve(repoRoot, "packages/db/migrations");

const findings = [];
const note = (file, line, message) =>
  findings.push(`${file}${line ? `:${line}` : ""}  ${message}`);

// --- helpers ---------------------------------------------------------------

const lineOf = (text, index) => text.slice(0, index).split("\n").length;

// Structural checks must not trip on SQL comments (templates and prose often
// quote DDL); JUDGMENT checks need exactly those comments. Blank out comment
// text but keep newlines so line numbers stay true.
function stripComments(sql) {
  return sql
    .replace(/--[^\n]*/g, (m) => " ".repeat(m.length))
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
}

const normalise = (name) => {
  const clean = name.replace(/"/g, "").toLowerCase();
  return clean.includes(".") ? clean : `public.${clean}`;
};

function tablesCreated(sql) {
  const out = [];
  const re = /create\s+table\s+(?:if\s+not\s+exists\s+)?([\w".]+)/gi;
  for (const m of sql.matchAll(re)) out.push({ table: normalise(m[1]), index: m.index });
  return out;
}

function rlsEnabled(sql) {
  const out = new Set();
  const re = /alter\s+table\s+(?:only\s+)?([\w".]+)\s+enable\s+row\s+level\s+security/gi;
  for (const m of sql.matchAll(re)) out.add(normalise(m[1]));
  return out;
}

// --- per-file checks -------------------------------------------------------

function lintFile(path) {
  const raw = readFileSync(path, "utf8");
  const sql = stripComments(raw);
  const file = basename(path);

  // 1. RLS enabled for each CREATE TABLE, same migration.
  const enabledHere = rlsEnabled(sql);
  const foundingRls =
    FOUNDING_EXCEPTION_FILES.has(file) && existsSync(resolve(migrationsDir, FOUNDING_RLS_FILE))
      ? rlsEnabled(stripComments(readFileSync(resolve(migrationsDir, FOUNDING_RLS_FILE), "utf8")))
      : new Set();
  for (const { table, index } of tablesCreated(sql)) {
    if (enabledHere.has(table)) continue;
    if (foundingRls.has(table)) continue; // Session 1 scaffold, RLS verified in 0012
    note(file, lineOf(sql, index), `CREATE TABLE ${table} without ENABLE ROW LEVEL SECURITY in the same migration`);
  }

  // 2. No DELETE policy reachable by users. A policy with no TO clause
  // applies to PUBLIC, so absence of TO is a finding too.
  for (const m of sql.matchAll(/create\s+policy[\s\S]*?;/gi)) {
    const stmt = m[0];
    if (!/for\s+delete/i.test(stmt)) continue;
    const to = stmt.match(/\bto\s+([\w, ]+)/i);
    const roles = to ? to[1].toLowerCase() : "public";
    if (/\b(authenticated|anon|public)\b/.test(roles)) {
      note(file, lineOf(sql, m.index), `DELETE policy for user roles (${roles.trim()}) — hard delete is Level 3+ service-role only`);
    }
  }

  // 3. JUDGMENT comments well-formed: `-- JUDGMENT: <rationale>`, exactly.
  const lines = raw.split("\n");
  lines.forEach((text, i) => {
    if (!/judge?ment/i.test(text)) return;
    if (!/--/.test(text)) return; // a column named judgment is not a mark
    if (/--\s*JUDGMENT:\s*\S/.test(text)) return; // well-formed
    if (/^\s*(--\s*)?</.test(text) || /\bjudgment (lanes|call|marks?)\b/i.test(text)) return; // prose, not a mark
    note(file, i + 1, `malformed JUDGMENT mark — the form is "-- JUDGMENT: <rationale>" (got: ${text.trim()})`);
  });
}

// --- git check: previously committed migrations must be untouched -----------

function checkCommittedMigrationsUntouched() {
  const relDir = "packages/db/migrations";
  const inHead = new Set(
    execFileSync("git", ["ls-tree", "-r", "HEAD", "--name-only", "--", relDir], {
      cwd: repoRoot,
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean)
      .map((p) => basename(p))
  );
  // Working tree AND index vs HEAD, in one view.
  const changed = execFileSync("git", ["status", "--porcelain", "--", relDir], {
    cwd: repoRoot,
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean);
  for (const entry of changed) {
    const status = entry.slice(0, 2);
    const name = basename(entry.slice(3).trim());
    if (!inHead.has(name)) continue; // a brand-new migration is the correct path
    note(name, 0, `previously committed migration has local ${status.includes("D") ? "deletion" : "edits"} (git status "${status}") — never edit an applied migration; fix forward with a new one`);
  }
}

// --- run ---------------------------------------------------------------------

const args = process.argv.slice(2);
let files;
if (args.length > 0) {
  files = args.map((a) => resolve(process.cwd(), a));
  const missing = files.filter((f) => !existsSync(f));
  if (missing.length) {
    console.error(`No such file: ${missing.join(", ")}`);
    process.exit(2);
  }
} else {
  files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => resolve(migrationsDir, f));
}

for (const f of files) lintFile(f);
checkCommittedMigrationsUntouched();

if (findings.length) {
  console.error(`check_migration: ${findings.length} finding(s)\n`);
  for (const f of findings) console.error(`  FAIL  ${f}`);
  console.error("\nReported, not fixed — fixing is the session's job, forward only.");
  process.exit(1);
}
console.log(`check_migration: green — ${files.length} file(s) linted, committed migrations untouched.`);
