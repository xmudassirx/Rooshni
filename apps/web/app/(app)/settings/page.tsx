import { PageHead } from "@/components/shell/page-head";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

// Founder amendment (mockup review): Settings is tabbed — General, Team &
// Access, Appearance, Integrations. Structure only this session; each tab's
// content arrives with its own feature.
const TABS = [
  {
    value: "general",
    label: "General",
    body: "Business name, timezone, locale and vocabulary — arrives with the settings session.",
  },
  {
    value: "team",
    label: "Team & Access",
    body: "Humans and AI, one permission system: members, presets and the grant matrix. No grant on a tool = no tab in their sidebar.",
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
      <PageHead title="Settings" sub="Structure only this session — each tab fills in with its feature" />
      <Tabs defaultValue="general">
        <TabsList>
          {TABS.map((t) => (
            <TabsTrigger key={t.value} value={t.value}>
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>
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
