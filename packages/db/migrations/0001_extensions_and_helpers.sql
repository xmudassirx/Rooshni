-- 0001: extensions and shared helper functions
-- Spec 1 §2.7: IDs are UUIDv7 — time-ordered, globally unique, index-friendly.

-- Private schema for helper functions that must not be exposed via PostgREST.
create schema if not exists private;

-- RLS policies call private.* helpers as the querying user, so authenticated
-- needs USAGE on the schema (PostgREST still never exposes it).
grant usage on schema private to authenticated, service_role;

-- UUIDv7 generator (RFC 9562). Postgres has no native uuidv7() until v18;
-- this is the standard implementation: 48-bit unix-ms timestamp + random.
create or replace function public.uuid_generate_v7()
returns uuid
language plpgsql
volatile
as $$
declare
  unix_ts_ms bytea;
  uuid_bytes bytea;
begin
  unix_ts_ms := substring(int8send(floor(extract(epoch from clock_timestamp()) * 1000)::bigint) from 3);
  uuid_bytes := uuid_send(gen_random_uuid());
  uuid_bytes := overlay(uuid_bytes placing unix_ts_ms from 1 for 6);
  -- set version (7) and variant (10) bits
  uuid_bytes := set_byte(uuid_bytes, 6, (b'0111' || get_byte(uuid_bytes, 6)::bit(4))::bit(8)::int);
  uuid_bytes := set_byte(uuid_bytes, 8, (b'10' || get_byte(uuid_bytes, 8)::bit(6))::bit(8)::int);
  return encode(uuid_bytes, 'hex')::uuid;
end;
$$;

-- Envelope: updated_at is trigger-maintained (Spec 1 §3).
create or replace function private.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- Append-only enforcement (Spec 1 §5.2 events, §4.2 stage_history):
-- rows are never updated or deleted, by anyone, ever.
create or replace function private.raise_append_only()
returns trigger
language plpgsql
as $$
begin
  raise exception '% is append-only: % is forbidden', tg_table_name, tg_op;
end;
$$;
