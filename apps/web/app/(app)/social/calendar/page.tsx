import { PageHead } from "@/components/shell/page-head";
import { HonestButton } from "@/components/ui/honest-button";

import { CreatePostButton } from "../social-shared";

/* view-socal, master mockup v2 — the week planner, as drawn, over an empty
   social store: seven real days, nothing planned, nothing pretended. */

export default function SocialCalendarPage() {
  const monday = new Date();
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    return d;
  });

  return (
    <>
      <PageHead
        title="Social"
        sub="The planner — Light drafts the week, you stamp it once"
        actions={
          <>
            <HonestButton
              variant="gold"
              notice="✦ The week's pending drafts land as ONE batch item in your Approval Inbox — stamp the calendar, not the posts. The batch arrives with the social store."
            >
              ✦ Batch-stamp this week
            </HonestButton>
            <CreatePostButton />
          </>
        }
      />

      <div className="glass overflow-hidden rounded-xl">
        <h2 className="border-b border-rule bg-paper px-4 py-3 font-mono text-[10.5px] font-semibold tracking-[.14em] text-ink-soft uppercase">
          Week of{" "}
          {monday.toLocaleDateString("en-GB", { day: "numeric", month: "long" })} ·
          composition is ours, delivery is connected · engagement lands in events — the
          organic twin of the ads loop
        </h2>
        <div className="grid grid-cols-7 max-[900px]:grid-cols-1">
          {days.map((d, i) => (
            <div
              key={i}
              className="min-h-[150px] border-r border-rule p-2 last:border-r-0 max-[900px]:min-h-0 max-[900px]:border-r-0 max-[900px]:border-b max-[900px]:last:border-b-0"
            >
              <div className="mb-2 font-mono text-[9px] tracking-[.12em] text-ink-faint uppercase">
                {d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric" })}
              </div>
              <div className="pt-9 text-center text-xs text-ink-faint max-[900px]:pt-2">—</div>
            </div>
          ))}
        </div>
      </div>
      <p className="mt-2.5 text-center font-mono text-[10.5px] text-ink-faint uppercase">
        Nothing planned — the calendar fills when the social store and Light&rsquo;s
        drafting arrive; posting cadence is a preference, not a habit
      </p>

      <p className="mt-3 font-mono text-xs text-ink-faint">
        PUBLISHING IS LEVEL 3 — THE BATCH STAMP IS ONE INBOX ITEM FOR THE WHOLE WEEK.
        NO_GO_RULES APPLY TO POSTS LIKE EVERYTHING ELSE.
      </p>
    </>
  );
}
