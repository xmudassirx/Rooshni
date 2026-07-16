import { PageHead } from "@/components/shell/page-head";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { AppearanceTab } from "./appearance-tab";
import { GeneralTab } from "./general-tab";
import { TeamTab } from "./team-tab";

export const dynamic = "force-dynamic";

// Founder amendment (mockup review): Settings is tabbed — General, Team &
// Access, Appearance, Integrations. Session 8 + its fix round fill General,
// Team & Access and Appearance (the ONLY appearance door — the top-bar Aa is
// gone by founder ruling); Integrations arrives with its wiring sessions.

export default function SettingsPage() {
  return (
    <>
      <PageHead
        title="Settings"
        sub="Humans and AI, one permission system — General, Team & Access and Appearance are live"
      />
      <Tabs defaultValue="general">
        <TabsList>
          <TabsTrigger value="general">General</TabsTrigger>
          <TabsTrigger value="team">Team &amp; Access</TabsTrigger>
          <TabsTrigger value="appearance">Appearance</TabsTrigger>
          <TabsTrigger value="integrations">Integrations</TabsTrigger>
        </TabsList>
        <TabsContent value="general">
          <GeneralTab />
        </TabsContent>
        <TabsContent value="team">
          <TeamTab />
        </TabsContent>
        <TabsContent value="appearance">
          <AppearanceTab />
        </TabsContent>
        <TabsContent value="integrations">
          <div className="glass rounded-xl border-dashed p-6">
            <h2 className="mb-1.5 font-display text-lg font-extrabold">Integrations</h2>
            <p className="max-w-[60ch] text-sm text-ink-soft">
              Meta Lead Ads, mail and calendar connections, media providers over
              MCP — connections live once, here, and each arrives with its
              wiring session. Integrations are actors: every write is a line on
              The Record.
            </p>
          </div>
        </TabsContent>
      </Tabs>
    </>
  );
}
