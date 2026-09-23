create or replace function public.lister_create_batch(p_id uuid,p_workspace uuid,p_environment text,p_groups jsonb,p_connection text)
returns void language plpgsql set search_path = public as $$
begin
 insert into public.lister_batches(id,workspace_id,environment,sealed_connection) values(p_id,p_workspace,p_environment,p_connection);
 insert into public.lister_items(batch_id,client_id,sku,draft)
 select p_id,g->>'id',g->>'sku',g from jsonb_array_elements(p_groups) g;
 insert into public.lister_photos(batch_id,client_id,bucket_id,object_path)
 select p_id,p,'lister-photos-'||p_environment,p_workspace::text||'/'||p_id::text||'/'||p
 from (select distinct jsonb_array_elements_text(g->'photoIds') p from jsonb_array_elements(p_groups) g) photos;
end $$;
revoke all on function public.lister_create_batch(uuid,uuid,text,jsonb,text) from public,anon,authenticated;
grant execute on function public.lister_create_batch(uuid,uuid,text,jsonb,text) to service_role;
