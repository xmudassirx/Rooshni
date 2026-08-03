import type { SupabaseClient } from "@supabase/supabase-js";

import { declaredTemplateQuietHours, type QuietHours } from "./quiet-hours";

/**
 * Installable vertical templates (Session 11). The definition rows live in
 * template_definitions (0022) — founder content, re-issued by migration with
 * a version bump, never rewritten. Everything vertical-specific the product
 * shows renders FROM a definition (the session-9 addendum rule): the signup
 * footer, the accreditation options, the no-go seed, the knowledge-pack
 * checklist, the First Light row copy.
 *
 * Decision 79: UK Immigration Advisory applies by default — there is no
 * template picker; the vertical lives in Settings → General for the day
 * there is a second one.
 */

export const DEFAULT_TEMPLATE_KEY = "uk_immigration_advisory";

export interface TemplateStageDef {
  key: string;
  label: string;
  sort_order: number;
  terminal_outcome?: "won" | "lost" | "unresponsive" | "disqualified";
}

export interface TemplateEngagementTypeDef {
  key: string;
  label: string;
  stages: TemplateStageDef[];
}

export interface TemplateFirstLightRow {
  key: string;
  title: string;
  description: string;
  optional: boolean;
}

export interface TemplateDefinitionContent {
  signup_footer: string;
  vocabulary: { term_key: string; label: string }[];
  engagement_types: TemplateEngagementTypeDef[];
  field_definitions: { entity: string; key: string; label: string; data_type: string }[];
  business_identity: {
    standard_keys: string[];
    regulated_status_options: string[];
    defaults: {
      locale: string;
      timezone: string;
      currency: string;
      quiet_hours: { start: string; end: string };
    };
  };
  no_go_rules: string[];
  knowledge_pack_categories: string[];
  first_light_rows: TemplateFirstLightRow[];
}

export interface TemplateDefinition {
  id: string;
  key: string;
  version: number;
  displayName: string;
  content: TemplateDefinitionContent;
}

/**
 * The default installable template, latest issued version. Readable by any
 * signed-in session (RLS select policy) and by the service client on the
 * public signup surface — the definition is product content, not tenant data.
 */
/**
 * The quiet-hours default DECLARED by a business's installed template
 * (Session 26, C5, founder-ruled): businesses.template_id → the install
 * pointer (vertical + version) → template_definitions.definition
 * .business_identity.defaults.quiet_hours, validated. Null when the business
 * has no install or the declaration is absent/malformed — resolution then
 * falls to the install-less QUIET_HOURS_DEFAULT constant.
 */
export async function getInstalledQuietHoursDefault(
  db: SupabaseClient,
  businessId: string
): Promise<QuietHours | null> {
  const { data: biz, error } = await db
    .from("businesses")
    .select("template_id, templates!businesses_template_id_fkey(vertical, version)")
    .eq("id", businessId)
    .maybeSingle();
  if (error) throw new Error(`template pointer lookup failed: ${error.message}`);
  const install = (Array.isArray(biz?.templates) ? biz?.templates[0] : biz?.templates) as
    | { vertical: string; version: number }
    | null
    | undefined;
  if (!install) return null;

  const { data: def, error: defError } = await db
    .from("template_definitions")
    .select("definition")
    .eq("key", install.vertical)
    .eq("version", install.version)
    .maybeSingle();
  if (defError) throw new Error(`template definition lookup failed: ${defError.message}`);
  const declared = (def?.definition as TemplateDefinitionContent | undefined)?.business_identity
    ?.defaults?.quiet_hours;
  return declaredTemplateQuietHours(declared);
}

export async function getDefaultTemplateDefinition(
  db: SupabaseClient,
  key: string = DEFAULT_TEMPLATE_KEY
): Promise<TemplateDefinition> {
  const { data, error } = await db
    .from("template_definitions")
    .select("id, key, version, display_name, definition")
    .eq("key", key)
    .is("archived_at", null)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`template definition lookup failed: ${error.message}`);
  if (!data) throw new Error(`No installable template definition for "${key}"`);
  return {
    id: data.id,
    key: data.key,
    version: data.version,
    displayName: data.display_name,
    content: data.definition as TemplateDefinitionContent,
  };
}
