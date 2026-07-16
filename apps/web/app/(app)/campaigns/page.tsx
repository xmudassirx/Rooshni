import { PageHead } from "@/components/shell/page-head";
import { HonestButton } from "@/components/ui/honest-button";

/*
 * view-campaigns, master mockup v2: segments are saved views over contacts
 * (no lists to sync, ever), saved blocks are the website-headers model, and
 * every campaign is one Level 3 stamp. No campaign store, no segment store,
 * no sending pipes exist yet — every panel states its honest not-yet.
 */

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="glass mb-4 overflow-hidden rounded-xl">
      <h2 className="border-b border-rule bg-paper px-4 py-3 font-mono text-[10.5px] font-semibold tracking-[.14em] text-ink-soft uppercase">
        {title}
      </h2>
      {children}
    </div>
  );
}

export default function CampaignsPage() {
  return (
    <>
      <PageHead
        title="Campaigns"
        sub="Bulk email through our pipes — segments are views over contacts, opens land on the thread"
        actions={
          <>
            <HonestButton notice="Sending pipes are not configured yet — bundled SES-class pipes are the default (a second synced contact store is forbidden); BYO-ESP is the buried advanced option. Both arrive with the campaigns session.">
              Sending: not configured
            </HonestButton>
            <HonestButton
              variant="primary"
              notice="New campaign: pick a segment → Light drafts to the writing standard → the WHOLE campaign is one Level 3 stamp in your Inbox. The campaign store arrives with its session."
            >
              + New campaign
            </HonestButton>
          </>
        }
      />

      <Panel title="Segments · saved views over contacts — no lists to sync, ever">
        <p className="max-w-[75ch] px-5 py-6 text-[13px] text-ink-soft">
          No segments saved yet. A segment is a stored search — enquiry stage,
          consent, tags — whose membership recomputes at SEND time: revoke
          consent at 09:59 and the 10:00 send skips you. Light will propose
          segments when patterns earn them.
        </p>
      </Panel>

      <Panel title="Saved blocks · build once, every campaign wears them — same model as the website's headers">
        <p className="max-w-[75ch] px-5 py-6 text-[13px] text-ink-soft">
          No blocks yet. The header, the footer with its locked unsubscribe line
          and the &ldquo;Was this useful?&rdquo; feedback module, and the
          book-a-consultation CTA all live here — and any block built inside a
          campaign can be saved back to this library.
        </p>
      </Panel>

      <Panel title="Campaigns · every send is one stamp · opens and clicks land in communications, on the contact's own thread">
        <div className="grid grid-cols-[1fr_150px_130px_210px] gap-3 border-b border-rule bg-accent-tint px-4 py-2.5 font-mono text-[9.5px] font-semibold tracking-[.14em] text-accent uppercase max-[760px]:grid-cols-[1fr_130px]">
          <span>Campaign</span>
          <span>Segment</span>
          <span className="max-[760px]:hidden">State</span>
          <span className="max-[760px]:hidden">Results</span>
        </div>
        <div className="px-6 py-10 text-center">
          <h3 className="mb-1.5 font-display text-lg font-extrabold">No campaigns yet</h3>
          <p className="mx-auto max-w-[46ch] text-[13px] text-ink-soft">
            When the first campaign exists, its opens and clicks will sit on
            each recipient&rsquo;s own thread in Conversations — never orphaned
            in a campaign report.
          </p>
        </div>
      </Panel>

      <p className="font-mono text-xs text-ink-faint">
        1:1 EMAIL SENDS VIA THE FIRM&rsquo;S OWN MAILBOX (PHASE 1) · BULK RIDES BUNDLED PIPES
        UNDER OUR UI (PHASE 2) · CONSENT ENFORCED PER CHANNEL AT SEND TIME · DELIVERABILITY
        (SPF/DKIM, WARM-UP, HYGIENE) IS OWNED ENGINEERING.
      </p>
    </>
  );
}
