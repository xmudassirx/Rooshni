import { PageHead } from "@/components/shell/page-head";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { TeamTab } from "./team-tab";

// Founder amendment (mockup review): Settings is tabbed — General, Team &
// Access, Appearance, Integrations. Structure only this session; each tab's
// content arrives with its own feature. Session 8 fills Team & Access only —
// the door to the member pages and the Amal role page (view-member,
// view-agentrole need a way in; everything else here is untouched).
const TABS = [
  {
    value: "general",
    label: "General",
    body: "Business name, timezone, locale and vocabulary — arrives with the settings session.",
  },
  {
    value: "appearance",
    label: "Appearance",
    body: "Theme, accent, font and size controls. Until they land here, the theme switcher lives in the top bar (Aa). Gold always means Light acted; red always means your stamp.",
  },
  {
    value: "integrations",
    label: "Integrations",
    body: "Meta Lead Ads, mail and calendar connections — each arrives with its wiring session.",
  },
];

export default function SettingsPage() {
  return (
    <>
      <PageHead title="Settings" sub="Each tab fills in with its feature — Team & Access is live" />
      <Tabs defaultValue="general">
        <TabsList>
          <TabsTrigger value="general">General</TabsTrigger>
          <TabsTrigger value="team">Team &amp; Access</TabsTrigger>
          {TABS.slice(1).map((t) => (
            <TabsTrigger key={t.value} value={t.value}>
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="team">
          <TeamTab />
        </TabsContent>
        {TABS.map((t) => (
          <TabsContent key={t.value} value={t.value}>
            <div className="glass rounded-xl border-dashed p-6">
              <h2 className="mb-1.5 font-display text-lg font-extrabold">{t.label}</h2>
              <p className="max-w-[60ch] text-sm text-ink-soft">{t.body}</p>
            </div>
          </TabsContent>
        ))}
      </Tabs>
    </>
  );
}
