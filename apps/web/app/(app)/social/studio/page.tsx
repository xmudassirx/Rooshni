import { PageHead } from "@/components/shell/page-head";

import { CreatePostButton } from "../social-shared";
import { StudioClient } from "./studio-client";

export default function SocialStudioPage() {
  return (
    <>
      <PageHead
        title="Social"
        sub="Studio — images and video, made by Light through the providers you connect"
        actions={<CreatePostButton />}
      />
      <StudioClient />
      <p className="mt-3 font-mono text-xs text-ink-faint">
        PROVIDERS ARE ACTORS WITH GRANTS, CONNECTED OVER MCP — ONE PLACE, SETTINGS →
        INTEGRATIONS. GENERATIONS BILL THROUGH THE SAME CREDITS AND CAPS. STORAGE LAW: IMAGES
        → R2 (ZERO-EGRESS); VIDEO → NEVER OUR BYTES — PROVIDER CDN VIA SIGNED URL, POSTER +
        PROVENANCE HERE, META HOSTS THE PUBLISHED COPY; UNPINNED ASSETS EXPIRE AFTER 30 DAYS.
        NOTHING PUBLISHES WITHOUT YOUR STAMP.
      </p>
    </>
  );
}
