-- 0004: the events ledger (Spec 1 §5.2) — built first, append-only, no
-- updates, no deletes, ever. Every layer writes to it (via emitEvent() only).

create table public.events (
  id uuid primary key default public.uuid_generate_v7(),
  business_id uuid not null references public.businesses (id),
  actor_id uuid not null references public.actors (id),
  action text not null,
  entity_type text,
  entity_id uuid,
  payload jsonb not null default '{}'::jsonb,
  approval jsonb,
  cost jsonb,
  occurred_at timestamptz not null default now(),
  -- namespaced verb: contact.created, engagement.stage_changed, grant.issued…
  constraint events_action_is_namespaced check (action ~ '^[a-z_]+\.[a-z_]+$')
);

create index events_business_occurred_idx on public.events (business_id, occurred_at desc);
create index events_entity_idx on public.events (entity_type, entity_id);
create index events_action_idx on public.events (business_id, action);

-- Structural append-only enforcement: triggers refuse UPDATE and DELETE for
-- every role, including the service role. Privileges are revoked as well —
-- belt and braces.
create trigger events_append_only
  before update or delete on public.events
  for each row execute function private.raise_append_only();

revoke update, delete on public.events from anon, authenticated, service_role;
