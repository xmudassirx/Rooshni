/**
 * Refusal-test template — the four-beat pattern every enforcement must prove:
 *
 *   seed → attempt the forbidden thing → expect the database to throw
 *        → assert nothing changed.
 *
 * The harness is packages/db/scripts/check-local.ts: tests live INLINE in
 * that file (there is no separate test runner). This template is not
 * imported — copy the block below into check-local.ts at the section for
 * your session, replace the <placeholders>, and re-run the whole harness:
 *
 *   npm run check-local        (from the repo root)
 *
 * House rules (smoke-tests SKILL.md):
 *   - the test name states the promise: "an agent actor cannot approve a
 *     communication", never "trigger test 3"
 *   - seed what you need; depend on no other test's leftovers
 *   - match the REAL error (run once, read the message, then pin the
 *     pattern) — a regex that matches any error proves nothing
 *   - beat 4 is not optional: a throw that still mutated the row is a
 *     failing enforcement wearing a passing test
 */

// The harness provides these; they exist here only so the template
// typechecks when read in isolation.
declare const db: {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  exec(sql: string): Promise<unknown>;
};
declare function expectError(
  label: string,
  pattern: RegExp,
  fn: () => Promise<unknown>
): Promise<void>;
declare function expectOk(label: string, fn: () => Promise<unknown>): Promise<void>;
declare const f: { business_id: string; human_id: string; agent_id: string };

// ---------------------------------------------------------------------------
// <Session N> — <the enforcement being proven, in one line>
// ---------------------------------------------------------------------------

// Beat 1 — SEED: the minimum rows the forbidden attempt needs. Use the
// shared fixture actors (f.human_id / f.agent_id) where they fit.
const seeded = await db.query<{ id: string }>(
  `insert into public.<table> (business_id, created_by, <columns>)
   values ($1, $2, <values>) returning id`,
  [f.business_id, f.human_id]
);
const rowId = seeded.rows[0]!.id;

// Beats 2 + 3 — ATTEMPT the forbidden thing, EXPECT the throw. The pattern
// pins the enforcement's own error text, so a different failure cannot
// impersonate a pass. If the rule only binds API roles (column privileges,
// RLS), wrap in `set role authenticated/service_role` … `reset role` — the
// superuser bypasses both (see "the stage door" tests for the pattern).
await expectError(
  "<the promise, stated as a refusal>",
  /<fragment of the real error message>/,
  () =>
    db.query(`update public.<table> set <forbidden change> where id = $1`, [rowId])
);

// Beat 4 — ASSERT UNCHANGED: read the row back; the refusal must have left
// no mark.
await expectOk("the refused <attempt> left the row untouched", async () => {
  const r = await db.query<{ [column: string]: string }>(
    `select <column> from public.<table> where id = $1`,
    [rowId]
  );
  if (r.rows[0]!.<column> !== <seeded value>) {
    throw new Error("the row changed despite the refusal");
  }
});

// And the other half — the permitted path succeeding. An enforcement test
// without its happy path proves the door is stuck, not that it is a door.
await expectOk("<the permitted equivalent succeeds>", () =>
  db.query(`<the same act, done the lawful way>`, [rowId, f.human_id])
);
