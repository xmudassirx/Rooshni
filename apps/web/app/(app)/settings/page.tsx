import { PageHead } from "@/components/shell/page-head";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { AppearanceTab } from "./appearance-tab";
import { GeneralTab } from "./general-tab";
import { IntegrationsTab } from "./integrations-tab";
import { KnowledgeTab } from "./knowledge-tab";
import { TeamTab } from "./team-tab";

export const dynamic = "force-dynamic";

// Founder amendment (mockup review): Settings is tabbed — General, Team &
// Access, Appearance, Integrations. Session 8 + its fix round fill General,
// Team & Access and Appearance (the ONLY appearance door — the top-bar Aa is
// gone by founder ruling); Session 11 fills Integrations with honest
// connection state (the one door, decision 58 — First Light deep-links here
// and state reflects back). Session 15 adds Knowledge — the pack's one door
// (PR-1): what Light may draft from, firm-curated, versioned, evented.

const TAB_VALUES = new Set(["general", "knowledge", "team", "appearance", "integrations"]);

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const { tab } = await searchParams;
  const activeTab = tab && TAB_VALUES.has(tab) ? tab : "general";

  return (
    <>
      <PageHead
        title="Settings"
        sub="Humans and AI, one permission system — connections live here, once"
      />
      <Tabs defaultValue={activeTab}>
        <TabsList>
          <TabsTrigger value="general">General</TabsTrigger>
          <TabsTrigger value="knowledge">Knowledge</TabsTrigger>
          <TabsTrigger value="team">Team &amp; Access</TabsTrigger>
          <TabsTrigger value="appearance">Appearance</TabsTrigger>
          <TabsTrigger value="integrations">Integrations</TabsTrigger>
        </TabsList>
        <TabsContent value="general">
          <GeneralTab />
        </TabsContent>
        <TabsContent value="knowledge">
          <KnowledgeTab />
        </TabsContent>
        <TabsContent value="team">
          <TeamTab />
        </TabsContent>
        <TabsContent value="appearance">
          <AppearanceTab />
        </TabsContent>
        <TabsContent value="integrations">
          <IntegrationsTab />
        </TabsContent>
      </Tabs>
    </>
  );
}
