begin;
alter table public.lister_batches add column if not exists sealed_connection text;
alter table public.lister_batches add column if not exists settings jsonb not null default '{}'::jsonb;
commit;
