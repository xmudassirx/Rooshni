-- 0042: route classification, the complete shape — provenance + precedence
-- enforced in the database (Session 27, D161 — founder-ruled 2 Aug 2026,
-- quoted in DECISIONS.md entry 161).
--
-- The ruled ladder: provenance recorded on the field
-- (human | form_answer | light | form_default), precedence
-- human > form_answer > light > form_default; "Light never overwrites a
-- human- or form-answer-sourced route"; "A human-set route is final against
-- machine writes."
--
-- The standing principle (law 4): precedence that must be true is enforced
-- HERE, not in app code. The value stays where every surface already reads
-- it — engagements.attributes.visa_route (the 0022-declared field) — with
-- attributes.visa_route_source beside it; a trigger refuses any change to
-- either key that does not come through the single door below (the 0030
-- transaction-local-gate pattern). Ledger events ride emitEvent() app-side
-- (law 11 — SQL never writes the ledger).
--
-- JUDGMENT: provenance lives in attributes (visa_route_source), not a new
-- column — it is bookkeeping ABOUT a declared-attribute field, read only
-- beside it; the trigger makes drift impossible, which is what a column
-- would have bought. The value key is untouched so no reader changes.

-- ---------------------------------------------------------------------------
-- 1. The guard: attributes.visa_route / visa_route_source move only through
--    the door. Any other write path — service role included — is refused.
-- ---------------------------------------------------------------------------
create or replace function private.protect_engagement_route()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_gate text := current_setting('rooshni.engagement_route_gate', true);
begin
  if tg_op = 'INSERT' then
    if new.attributes ? 'visa_route' or new.attributes ? 'visa_route_source' then
      raise exception 'The visa route is set through set_engagement_route() after insert — an engagement is never born with one';
    end if;
    return new;
  end if;
  if (new.attributes -> 'visa_route') is distinct from (old.attributes -> 'visa_route')
     or (new.attributes -> 'visa_route_source') is distinct from (old.attributes -> 'visa_route_source') then
    if v_gate is null or v_gate <> new.id::text then
      raise exception 'The visa route and its provenance change only through set_engagement_route() — direct writes are refused';
    end if;
  end if;
  return new;
end;
$$;

create trigger engagements_protect_route
  before insert or update on public.engagements
  for each row execute function private.protect_engagement_route();

-- ---------------------------------------------------------------------------
-- 2. The door. Precedence lives here; every caller — browser session,
--    server code, future integrations — obeys the same ladder.
--
--    Caller rules (the 0016/0017 pattern): a signed-in caller acts only as
--    their own actor within their own business, and may write only source
--    'human' (a browser session can never claim machine provenance).
--    Machine sources are server-side only, attributed to the acting
--    machine actor. Rank: human 4 > form_answer 3 > light 2 > form_default 1.
--    A write at lower-or-equal rank than the standing source is refused,
--    with two ruled exceptions: a human may correct a human ("editable by
--    any team member"), and a form answer may re-state a form answer (a
--    resubmission carrying the same question). Light writes ONLY over unset
--    or form_default — never over another confident read.
-- ---------------------------------------------------------------------------
create or replace function public.set_engagement_route(
  p_engagement uuid,
  p_route text,
  p_source text,
  p_actor uuid,
  p_reason text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_eng record;
  v_prev_route text;
  v_prev_source text;
  v_actor_type text;
  v_allowed boolean;
  v_rank_new int;
  v_rank_old int;
begin
  if p_source not in ('human', 'form_answer', 'light', 'form_default') then
    raise exception 'Unknown route source "%" — human | form_answer | light | form_default', p_source;
  end if;
  if p_route is null or btrim(p_route) = '' then
    raise exception 'A route must be named — clearing a route is not a write this door offers';
  end if;

  select e.id, e.business_id, e.attributes into v_eng
  from public.engagements e
  where e.id = p_engagement and e.archived_at is null
  for update;
  if not found then
    raise exception 'Engagement % not found (or archived)', p_engagement;
  end if;

  perform private.assert_pipeline_caller(p_actor, v_eng.business_id);

  select a.actor_type into v_actor_type
  from public.actors a where a.id = p_actor and a.archived_at is null;
  if v_actor_type is null then
    raise exception 'Acting actor % not found (or archived)', p_actor;
  end if;

  -- A browser session writes human provenance only, as a human actor.
  if (select auth.uid()) is not null and p_source <> 'human' then
    raise exception 'A signed-in session may only reclassify as source "human"';
  end if;
  if p_source = 'human' and v_actor_type <> 'human' then
    raise exception 'Source "human" requires a human actor — % is "%"', p_actor, v_actor_type;
  end if;
  if p_source <> 'human' and v_actor_type = 'human' then
    raise exception 'A human actor records source "human", never machine provenance';
  end if;

  -- The route must belong to the declared vocabulary when one is installed
  -- (0024: field_definitions content.visa_route validation.allowed — the
  -- same vocabulary the enquiry rows use).
  if exists (
    select 1
    from public.field_definitions fd
    join public.businesses b on b.template_id = fd.template_id
    where b.id = v_eng.business_id
      and fd.entity = 'content' and fd.key = 'visa_route'
      and fd.archived_at is null
      and fd.validation ? 'allowed'
  ) and not exists (
    select 1
    from public.field_definitions fd
    join public.businesses b on b.template_id = fd.template_id,
    lateral jsonb_array_elements(fd.validation -> 'allowed') a
    where b.id = v_eng.business_id
      and fd.entity = 'content' and fd.key = 'visa_route'
      and fd.archived_at is null
      and a ->> 'key' = p_route
  ) then
    raise exception 'Route "%" is not in the declared route vocabulary', p_route;
  end if;

  v_prev_route := v_eng.attributes ->> 'visa_route';
  v_prev_source := v_eng.attributes ->> 'visa_route_source';

  -- The precedence ladder.
  v_rank_new := case p_source when 'human' then 4 when 'form_answer' then 3 when 'light' then 2 else 1 end;
  v_rank_old := case v_prev_source when 'human' then 4 when 'form_answer' then 3 when 'light' then 2 when 'form_default' then 1 else 0 end;
  v_allowed := case
    when p_source = 'human' then true
    when p_source = 'light' then v_rank_old <= 1                -- unset or form_default only
    when p_source = 'form_answer' then v_rank_old < 4 and (v_rank_old < 3 or v_prev_source = 'form_answer')
    else v_rank_old = 0                                          -- form_default over unset only
  end;
  if not v_allowed then
    raise exception 'Route precedence refuses source "%" over standing source "%" — human > form_answer > light > form_default',
      p_source, coalesce(v_prev_source, 'unset');
  end if;

  perform set_config('rooshni.engagement_route_gate', p_engagement::text, true);
  update public.engagements
  set attributes = jsonb_set(
        jsonb_set(coalesce(attributes, '{}'::jsonb), '{visa_route}', to_jsonb(p_route), true),
        '{visa_route_source}', to_jsonb(p_source), true)
  where id = p_engagement;
  perform set_config('rooshni.engagement_route_gate', '', true);

  return jsonb_build_object(
    'previous_route', v_prev_route,
    'previous_source', v_prev_source,
    'route', p_route,
    'source', p_source
  );
end;
$$;
