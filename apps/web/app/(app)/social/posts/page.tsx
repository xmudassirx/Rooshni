import { PageHead } from "@/components/shell/page-head";

import { CreatePostButton } from "../social-shared";
import { PostsFilters } from "./posts-client";

/* view-soposts, master mockup v2 — every post ever; the store is empty and
   the table says so. */

export default function SocialPostsPage() {
  return (
    <>
      <PageHead
        title="Social"
        sub="Every post ever — filter, learn, reuse"
        actions={<CreatePostButton />}
      />
      <PostsFilters />
      <div className="glass overflow-hidden rounded-xl">
        <div className="grid grid-cols-[1fr_120px_110px_200px] gap-3 border-b border-rule bg-accent-tint px-4 py-2.5 font-mono text-[9.5px] font-semibold tracking-[.14em] text-accent uppercase max-[760px]:grid-cols-[1fr_110px]">
          <span>Post</span>
          <span>Channel</span>
          <span className="max-[760px]:hidden">State</span>
          <span className="max-[760px]:hidden">Result</span>
        </div>
        <div className="px-6 py-10 text-center">
          <h3 className="mb-1.5 font-display text-lg font-extrabold">No posts yet</h3>
          <p className="mx-auto max-w-[46ch] text-[13px] text-ink-soft">
            Posts are content items whose results come home as events — reach,
            taps, enquiries, each a line on The Record. The store arrives with
            the social session; an empty table is the truth.
          </p>
        </div>
      </div>
      <p className="mt-3 font-mono text-xs text-ink-faint">
        POSTS ARE CONTENT_ITEMS · PUBLISHING IS LEVEL 3 · NO_GO_RULES SCAN EVERY POST: NO
        CASE SPECIFICS, NO ADVICE, NO GUARANTEES.
      </p>
    </>
  );
}
