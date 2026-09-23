-- First cloud increment: service-only persistence, not yet connected to the UI.
begin;
create table if not exists public.lister_batches (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  environment text not null check (environment in ('preview','production')),
  status text not null default 'draft' check (status in ('draft','queued','running','paused','completed','failed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '30 days'
);
create index if not exists lister_batches_workspace on public.lister_batches (workspace_id, environment, created_at desc);
create table if not exists public.lister_items (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.lister_batches(id) on delete cascade,
  client_id text not null,
  sku text not null,
  revision integer not null default 1 check (revision > 0),
  draft jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (batch_id, client_id),
  unique (batch_id, sku)
);
create table if not exists public.lister_photos (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.lister_batches(id) on delete cascade,
  client_id text not null,
  bucket_id text not null,
  object_path text not null,
  state text not null default 'pending' check (state in ('pending','uploaded','deleted')),
  created_at timestamptz not null default now(),
  unique (batch_id, client_id),
  unique (bucket_id, object_path)
);
create table if not exists public.lister_jobs (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.lister_items(id) on delete cascade,
  revision integer not null check (revision > 0),
  stage text not null check (stage in ('analyze','prepare','research','publish')),
  status text not null default 'queued' check (status in ('queued','running','succeeded','failed','cancelled')),
  attempts integer not null default 0 check (attempts >= 0),
  approved_at timestamptz,
  approved_snapshot jsonb,
  result jsonb,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (item_id, revision, stage),
  check (stage <> 'publish' or (approved_at is not null and approved_snapshot is not null))
);
create index if not exists lister_jobs_status on public.lister_jobs(status, created_at);
-- No public/browser read or write grants; the application server must enforce workspace ownership.
alter table public.lister_batches enable row level security;
alter table public.lister_items enable row level security;
alter table public.lister_photos enable row level security;
alter table public.lister_jobs enable row level security;
revoke all on public.lister_batches, public.lister_items, public.lister_photos, public.lister_jobs from public, anon, authenticated;
grant select, insert, update, delete on public.lister_batches, public.lister_items, public.lister_photos, public.lister_jobs to service_role;
-- Originals stay local; this bucket is for bounded JPEG derivatives in Preview.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('lister-photos-preview','lister-photos-preview',false,8388608,array['image/jpeg'])
on conflict (id) do nothing;
commit;
