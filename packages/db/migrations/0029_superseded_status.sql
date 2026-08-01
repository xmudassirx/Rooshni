-- 0029: the `superseded` communication status (Session 16, PR-B; decision
-- 133a). A pending outbound draft the world has moved past — a new inbound
-- settled, or a human replied — transitions to `superseded`: terminal,
-- evented, visible in Approval Inbox History, never deletable.
--
-- This migration adds ONLY the enum value. Postgres forbids using a value
-- added by ALTER TYPE inside the same transaction, and migrate.ts wraps each
-- file in one — so the value lands alone here and every use (guard indexes,
-- terminal enforcement, the supersede pipeline) follows in 0030.

alter type public.comm_status add value if not exists 'superseded';
