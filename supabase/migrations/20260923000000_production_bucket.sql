-- Production deployments store photo derivatives in their own private bucket
-- (see bucket() in lib/cloud/store.ts); Preview keeps lister-photos-preview.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('lister-photos-production','lister-photos-production',false,8388608,array['image/jpeg'])
on conflict (id) do nothing;
