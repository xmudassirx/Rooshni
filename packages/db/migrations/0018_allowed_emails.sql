-- 0018: the sign-in allowlist (Session 5).
--
-- Sign-in is Supabase Auth (Google); this table decides who gets past it.
-- Only an allowlisted email reaches the app — everyone else, signed in or
-- not, sees the public holding page. The allowlist is the front door only:
-- the tenancy wall stays memberships + RLS (0012), so a signed-in stranger
-- who somehow slipped past the door would still see zero rows everywhere.
--
-- Enforcement principle: a signed-in user can read exactly one fact from
-- this table — whether their own email is on it. Managing the list is a
-- gated service-role flow (no write policies), like actor creation.

create table public.allowed_emails (
  id uuid primary key default public.uuid_generate_v7(),
  email text not null,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  constraint allowed_emails_email_is_lower check (email = lower(email)),
  constraint allowed_emails_email_shape check (position('@' in email) > 1)
);

create unique index allowed_emails_email_uniq on public.allowed_emails (email);

create trigger allowed_emails_set_updated_at
  before update on public.allowed_emails
  for each row execute function private.set_updated_at();

alter table public.allowed_emails enable row level security;

-- A signed-in user sees their own live row or nothing: the row's presence IS
-- the answer to "am I allowed in?". Archiving a row revokes access without
-- losing the record of it having been granted.
create policy allowed_emails_select_own on public.allowed_emails
  for select to authenticated
  using (
    archived_at is null
    and email = lower(coalesce((select auth.jwt()) ->> 'email', ''))
  );

-- No insert/update/delete policies for authenticated: allowlist changes are
-- service-role only, until a gated settings.team flow exists in the UI.
