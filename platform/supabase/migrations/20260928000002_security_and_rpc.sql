-- Row-level security, client onboarding, publish / purge RPCs, storage buckets and policies.

-- ---------------------------------------------------------------- RLS on every table
alter table public.profiles enable row level security;
alter table public.clients enable row level security;
alter table public.client_members enable row level security;
alter table public.audit_log enable row level security;
alter table public.threshold_versions enable row level security;
alter table public.ruleset_versions enable row level security;
alter table public.column_profiles enable row level security;
alter table public.runs enable row level security;
alter table public.case_raw enable row level security;
alter table public.case_derived enable row level security;
alter table public.case_edits enable row level security;
alter table public.exceptions enable row level security;
alter table public.metric_snapshots enable row level security;
alter table public.run_artifacts enable row level security;

-- Nothing is readable without signing in.
revoke all on all tables in schema public from anon;
revoke all on all functions in schema public from anon;

-- profiles: an internal staff directory. Users edit only their own name; only admins change is_admin.
create policy profiles_read on public.profiles for select to authenticated using (true);
create policy profiles_update_self on public.profiles for update to authenticated using (id = auth.uid() or public.is_admin()) with check (id = auth.uid() or public.is_admin());
create or replace function public.profiles_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.is_admin is distinct from old.is_admin then
    if not public.is_admin() then raise exception 'Only administrators can change administrator access' using errcode = '42501'; end if;
    if old.id = auth.uid() and not new.is_admin then raise exception 'You cannot remove your own administrator access' using errcode = '42501'; end if;
    perform public.log_event(null, case when new.is_admin then 'Admin granted' else 'Admin revoked' end, 'profile', new.id::text, jsonb_build_object('email', new.email));
  end if;
  new.email := old.email;
  new.id := old.id;
  return new;
end $$;
create trigger profiles_guard before update on public.profiles for each row execute function public.profiles_guard();

-- clients
create policy clients_read on public.clients for select to authenticated using (public.can_read_client(id));
create policy clients_insert on public.clients for insert to authenticated with check (public.is_admin());
create policy clients_update on public.clients for update to authenticated using (public.has_client_role(id, array['owner'])) with check (public.has_client_role(id, array['owner']));
create policy clients_delete on public.clients for delete to authenticated using (public.is_admin());

-- client_members: members see their client's roster; admins and owners manage it.
create policy members_read on public.client_members for select to authenticated using (public.can_read_client(client_id));
create policy members_write on public.client_members for insert to authenticated with check (public.has_client_role(client_id, array['owner']));
create policy members_update on public.client_members for update to authenticated using (public.has_client_role(client_id, array['owner'])) with check (public.has_client_role(client_id, array['owner']));
create policy members_delete on public.client_members for delete to authenticated using (public.has_client_role(client_id, array['owner']));
create or replace function public.members_audit()
returns trigger language plpgsql security definer set search_path = '' as $$
declare r record;
begin
  r := coalesce(new, old);
  if tg_op = 'DELETE' and old.user_id = auth.uid() and not public.is_admin() then
    raise exception 'Ask an administrator or another owner to remove you' using errcode = '42501';
  end if;
  perform public.log_event(r.client_id, 'Membership ' || lower(tg_op), 'client_member', r.user_id::text,
    jsonb_build_object('role', case when tg_op = 'DELETE' then old.role else new.role end,
      'email', (select email from public.profiles where id = r.user_id)));
  return coalesce(new, old);
end $$;
create trigger members_audit after insert or update or delete on public.client_members for each row execute function public.members_audit();

-- audit_log: read by client members (client events) or admins (all). Written only by SECURITY DEFINER code.
create policy audit_read on public.audit_log for select to authenticated using (public.is_admin() or (client_id is not null and public.can_read_client(client_id)));

-- threshold versions: read by members, created by owners, never updated or deleted.
create policy thr_read on public.threshold_versions for select to authenticated using (public.can_read_client(client_id));
create policy thr_insert on public.threshold_versions for insert to authenticated with check (public.has_client_role(client_id, array['owner']));

-- rule sets: the global baseline is readable by everyone and maintained by admins.
create policy rs_read on public.ruleset_versions for select to authenticated using (client_id is null or public.can_read_client(client_id));
create policy rs_insert on public.ruleset_versions for insert to authenticated with check (case when client_id is null then public.is_admin() else public.has_client_role(client_id, array['owner']) end);
create policy rs_update on public.ruleset_versions for update to authenticated
  using (case when client_id is null then public.is_admin() else public.has_client_role(client_id, array['owner']) end)
  with check (case when client_id is null then public.is_admin() else public.has_client_role(client_id, array['owner']) end);
create policy rs_delete on public.ruleset_versions for delete to authenticated using (status = 'draft' and case when client_id is null then public.is_admin() else public.has_client_role(client_id, array['owner']) end);

-- column profiles
create policy cp_read on public.column_profiles for select to authenticated using (public.can_read_client(client_id));
create policy cp_write on public.column_profiles for insert to authenticated with check (public.has_client_role(client_id, array['owner']));
create policy cp_update on public.column_profiles for update to authenticated using (public.has_client_role(client_id, array['owner'])) with check (public.has_client_role(client_id, array['owner']));

-- runs: owners create and drive runs; reviewers may update status/summary during review.
create policy runs_read on public.runs for select to authenticated using (public.can_read_client(client_id));
create policy runs_insert on public.runs for insert to authenticated with check (public.has_client_role(client_id, array['owner']));
create policy runs_update on public.runs for update to authenticated using (public.has_client_role(client_id, array['owner', 'reviewer'])) with check (public.has_client_role(client_id, array['owner', 'reviewer']));
create policy runs_delete on public.runs for delete to authenticated using (status in ('draft', 'staged', 'review') and public.has_client_role(client_id, array['owner']));

create or replace function public.run_client(rid uuid)
returns uuid language sql stable security definer set search_path = '' as $$ select client_id from public.runs where id = rid $$;

create policy raw_read on public.case_raw for select to authenticated using (public.can_read_client(public.run_client(run_id)));
create policy raw_insert on public.case_raw for insert to authenticated with check (public.has_client_role(public.run_client(run_id), array['owner']));

create policy der_read on public.case_derived for select to authenticated using (public.can_read_client(public.run_client(run_id)));
create policy der_insert on public.case_derived for insert to authenticated with check (public.has_client_role(public.run_client(run_id), array['owner', 'reviewer']));
create policy der_update on public.case_derived for update to authenticated using (public.has_client_role(public.run_client(run_id), array['owner', 'reviewer'])) with check (public.has_client_role(public.run_client(run_id), array['owner', 'reviewer']));
create policy der_delete on public.case_derived for delete to authenticated using (public.has_client_role(public.run_client(run_id), array['owner']));

create policy edits_read on public.case_edits for select to authenticated using (public.can_read_client(public.run_client(run_id)));
create policy edits_insert on public.case_edits for insert to authenticated with check (public.has_client_role(public.run_client(run_id), array['owner', 'reviewer']));

create policy exc_read on public.exceptions for select to authenticated using (public.can_read_client(public.run_client(run_id)));
create policy exc_insert on public.exceptions for insert to authenticated with check (public.has_client_role(public.run_client(run_id), array['owner', 'reviewer']));
create policy exc_update on public.exceptions for update to authenticated using (public.has_client_role(public.run_client(run_id), array['owner', 'reviewer'])) with check (public.has_client_role(public.run_client(run_id), array['owner', 'reviewer']));
create policy exc_delete on public.exceptions for delete to authenticated using (public.has_client_role(public.run_client(run_id), array['owner', 'reviewer']));

create policy ms_read on public.metric_snapshots for select to authenticated using (public.can_read_client(public.run_client(run_id)));
create policy ms_write on public.metric_snapshots for insert to authenticated with check (public.has_client_role(public.run_client(run_id), array['owner']));
create policy ms_update on public.metric_snapshots for update to authenticated using (public.has_client_role(public.run_client(run_id), array['owner'])) with check (public.has_client_role(public.run_client(run_id), array['owner']));
create policy ms_delete on public.metric_snapshots for delete to authenticated using (public.has_client_role(public.run_client(run_id), array['owner']));

create policy art_read on public.run_artifacts for select to authenticated using (public.can_read_client(public.run_client(run_id)));
create policy art_insert on public.run_artifacts for insert to authenticated with check (public.has_client_role(public.run_client(run_id), array['owner', 'reviewer']));

-- ---------------------------------------------------------------- client onboarding
-- New clients start from the spec baseline: the creator becomes owner, SLA thresholds v1 are
-- the seed values, and the client's rule set is a published copy of the current global baseline.
create or replace function public.default_limits() returns jsonb language sql immutable as $$
select '{
 "Critical":{"TTA":{"value":30,"unit":"min","seconds":1800},"TTI":{"value":1,"unit":"h","seconds":3600},"TTC":{"value":4,"unit":"h","seconds":14400},"TTR":{"value":16,"unit":"h","seconds":57600}},
 "High":{"TTA":{"value":1,"unit":"h","seconds":3600},"TTI":{"value":2,"unit":"h","seconds":7200},"TTC":{"value":8,"unit":"h","seconds":28800},"TTR":{"value":20,"unit":"h","seconds":72000}},
 "Medium":{"TTA":{"value":8,"unit":"h","seconds":28800},"TTI":{"value":4,"unit":"h","seconds":14400},"TTC":{"value":12,"unit":"h","seconds":43200},"TTR":{"value":24,"unit":"h","seconds":86400}},
 "Low":{"TTA":{"value":12,"unit":"h","seconds":43200},"TTI":{"value":8,"unit":"h","seconds":28800},"TTC":{"value":24,"unit":"h","seconds":86400},"TTR":{"value":72,"unit":"h","seconds":259200}}
}'::jsonb $$;
create or replace function public.default_targets() returns jsonb language sql immutable as $$
select '{"Critical":{"TTA":98,"TTI":98,"TTC":98,"TTR":98},"High":{"TTA":97,"TTI":97,"TTC":97,"TTR":95},"Medium":{"TTA":90,"TTI":90,"TTC":90,"TTR":90},"Low":{"TTA":90,"TTI":90,"TTC":90,"TTR":90}}'::jsonb $$;

create or replace function public.clients_after_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
declare base record;
begin
  if auth.uid() is not null then
    insert into public.client_members (client_id, user_id, role, added_by) values (new.id, auth.uid(), 'owner', auth.uid())
    on conflict do nothing;
  end if;
  insert into public.threshold_versions (client_id, version_no, label, limits, targets, notes)
  values (new.id, 0, 'SEP-2026-SLA-01', public.default_limits(), public.default_targets(), 'Spec v2.0 baseline');
  select * into base from public.ruleset_versions where client_id is null and status = 'published' order by version_no desc limit 1;
  if found then
    insert into public.ruleset_versions (client_id, label, status, rules, notes, based_on)
    values (new.id, base.label, 'published', base.rules, 'Cloned from the global baseline ' || base.label, base.id);
  end if;
  perform public.log_event(new.id, 'Client created', 'client', new.id::text, jsonb_build_object('name', new.name));
  return null;
end $$;
create trigger clients_ai after insert on public.clients for each row execute function public.clients_after_insert();

-- Clone SLA thresholds and the rule set from another client (spec §4.2, §4.3.6).
create or replace function public.clone_client_config(p_from uuid, p_to uuid, p_thresholds boolean, p_rules boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare t record; r record;
begin
  if not (public.can_read_client(p_from) and public.has_client_role(p_to, array['owner'])) then
    raise exception 'You need read access to the source client and owner access to the target' using errcode = '42501';
  end if;
  if p_thresholds then
    select * into t from public.threshold_versions where client_id = p_from order by version_no desc limit 1;
    insert into public.threshold_versions (client_id, version_no, label, limits, targets, notes)
    values (p_to, 0, t.label, t.limits, t.targets, 'Cloned from ' || (select name from public.clients where id = p_from));
  end if;
  if p_rules then
    select * into r from public.ruleset_versions where client_id = p_from and status = 'published' order by version_no desc limit 1;
    if found then
      delete from public.ruleset_versions where client_id = p_to and status = 'draft';
      insert into public.ruleset_versions (client_id, label, status, rules, notes, based_on)
      values (p_to, r.label, 'published', r.rules, 'Cloned from ' || (select name from public.clients where id = p_from), r.id);
    end if;
  end if;
end $$;

-- ---------------------------------------------------------------- run lifecycle
create or replace function public.run_audit()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    perform public.log_event(new.client_id, 'Run created', 'run', new.id::text,
      jsonb_build_object('cadence', new.cadence, 'period_start', new.period_start, 'period_end', new.period_end));
  elsif new.status is distinct from old.status then
    perform public.log_event(new.client_id, 'Run ' || new.status, 'run', new.id::text,
      jsonb_build_object('from', old.status, 'to', new.status, 'file', new.source_file_name, 'hash', new.source_file_hash));
  elsif new.threshold_version_id is distinct from old.threshold_version_id or new.ruleset_version_id is distinct from old.ruleset_version_id then
    perform public.log_event(new.client_id, 'Run versions changed', 'run', new.id::text,
      jsonb_build_object('threshold_version_id', new.threshold_version_id, 'ruleset_version_id', new.ruleset_version_id));
  end if;
  return null;
end $$;
create trigger runs_audit after insert or update on public.runs for each row execute function public.run_audit();

-- Publish (spec §3.2 step 9, AT-07): owner only, blocked while any blocking exception is open or the
-- metric snapshot is missing. Earlier published runs for the same client and period are superseded.
create or replace function public.publish_run(p_run uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare r public.runs; n_block integer; n_ms integer;
begin
  select * into r from public.runs where id = p_run for update;
  if not found then raise exception 'Run not found' using errcode = 'P0002'; end if;
  if not public.has_client_role(r.client_id, array['owner']) then raise exception 'Only a reporting owner can publish' using errcode = '42501'; end if;
  if r.status <> 'review' then raise exception 'Only a run in review can be published (this one is %)', r.status using errcode = '22023'; end if;
  if r.threshold_version_id is null or r.ruleset_version_id is null then raise exception 'The run has no threshold or rule-set version recorded' using errcode = '22023'; end if;
  select count(*) into n_block from public.exceptions where run_id = p_run and severity = 'blocking' and status = 'open';
  if n_block > 0 then raise exception '% blocking exception(s) are still open', n_block using errcode = '22023'; end if;
  if coalesce((r.summary ->> 'blockingOpen')::int, 1) > 0 then raise exception 'The run summary still reports blocking exceptions. Recalculate the run.' using errcode = '22023'; end if;
  select count(*) into n_ms from public.metric_snapshots where run_id = p_run;
  if n_ms = 0 then raise exception 'Compliance snapshot missing. Recalculate the run.' using errcode = '22023'; end if;
  perform set_config('app.run_publish', 'on', true);
  update public.runs set status = 'superseded'
    where client_id = r.client_id and id <> r.id and status = 'published' and period_start = r.period_start and period_end = r.period_end;
  update public.runs set status = 'published', published_by = auth.uid(), published_at = now(),
    supersedes_run_id = coalesce(r.supersedes_run_id, (select id from public.runs where client_id = r.client_id and id <> r.id and status = 'superseded'
      and period_start = r.period_start and period_end = r.period_end order by published_at desc nulls last limit 1))
    where id = p_run;
  perform set_config('app.run_publish', 'off', true);
end $$;

-- Retention purge (spec §8.5): administrators only, always logged with a reason.
create or replace function public.purge_run(p_run uuid, p_reason text)
returns void language plpgsql security definer set search_path = '' as $$
declare r public.runs;
begin
  if not public.is_admin() then raise exception 'Only administrators can purge runs' using errcode = '42501'; end if;
  if char_length(btrim(coalesce(p_reason, ''))) < 5 then raise exception 'Give a reason for the purge' using errcode = '22023'; end if;
  select * into r from public.runs where id = p_run;
  if not found then raise exception 'Run not found' using errcode = 'P0002'; end if;
  perform public.log_event(r.client_id, 'Run purged', 'run', r.id::text,
    jsonb_build_object('reason', p_reason, 'period_start', r.period_start, 'period_end', r.period_end, 'status', r.status,
      'file', r.source_file_name, 'hash', r.source_file_hash, 'rows', r.row_count));
  -- Stored files are removed through the Storage API by the app before this call (Supabase blocks SQL deletes on storage.objects).
  perform set_config('app.purging', 'on', true);
  delete from public.runs where id = p_run;
  perform set_config('app.purging', 'off', true);
end $$;

-- Raw uploads older than the retention window (default 13 months), for the admin purge screen.
create or replace function public.runs_past_retention(p_months integer default 13)
returns setof public.runs language sql stable security definer set search_path = '' as $$
  select * from public.runs where public.is_admin() and created_at < now() - make_interval(months => p_months) order by created_at
$$;

grant execute on function public.publish_run(uuid) to authenticated;
grant execute on function public.purge_run(uuid, text) to authenticated;
grant execute on function public.clone_client_config(uuid, uuid, boolean, boolean) to authenticated;
grant execute on function public.runs_past_retention(integer) to authenticated;
grant execute on function public.is_admin() to authenticated;
grant execute on function public.has_client_role(uuid, text[]) to authenticated;
grant execute on function public.can_read_client(uuid) to authenticated;

-- Dashboard view: latest runs with headline numbers (RLS of the caller applies).
create view public.run_overview with (security_invoker = true) as
select r.id, r.client_id, c.name as client_name, r.cadence, r.period_start, r.period_end, r.status, r.row_count,
  r.source_file_name, r.created_at, r.published_at, r.updated_at, r.summary,
  tv.label as threshold_label, tv.version_no as threshold_version_no,
  rv.label as ruleset_label, rv.version_no as ruleset_version_no,
  (select count(*) from public.exceptions e where e.run_id = r.id and e.severity = 'blocking' and e.status = 'open') as blocking_open,
  (select count(*) from public.exceptions e where e.run_id = r.id and e.severity = 'non_blocking' and e.status = 'open') as nonblocking_open
from public.runs r
join public.clients c on c.id = r.client_id
left join public.threshold_versions tv on tv.id = r.threshold_version_id
left join public.ruleset_versions rv on rv.id = r.ruleset_version_id;
grant select on public.run_overview to authenticated;

-- ---------------------------------------------------------------- storage
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('uploads', 'uploads', false, 104857600, array['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'text/csv', 'application/octet-stream']),
  ('artifacts', 'artifacts', false, 104857600, null)
on conflict (id) do nothing;

-- Object names are <client_id>/<run_id>/<file>. The first folder decides access.
create or replace function public.storage_client(name text)
returns uuid language plpgsql immutable set search_path = '' as $$
begin
  return (string_to_array(name, '/'))[1]::uuid;
exception when others then
  return null;
end $$;

create policy "uploads read" on storage.objects for select to authenticated
  using (bucket_id = 'uploads' and public.can_read_client(public.storage_client(name)));
create policy "uploads insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'uploads' and public.has_client_role(public.storage_client(name), array['owner']));
create policy "artifacts read" on storage.objects for select to authenticated
  using (bucket_id = 'artifacts' and public.can_read_client(public.storage_client(name)));
create policy "artifacts insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'artifacts' and public.has_client_role(public.storage_client(name), array['owner', 'reviewer']));
create policy "storage admin delete" on storage.objects for delete to authenticated
  using (bucket_id in ('uploads', 'artifacts') and public.is_admin());

-- Owners may remove the files of their own unpublished runs (deleting a draft or a run in review).
create or replace function public.storage_run_unlocked(name text)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare rid uuid;
begin
  rid := (string_to_array(name, '/'))[2]::uuid;
  return not exists (select 1 from public.runs where id = rid and status in ('published', 'superseded'));
exception when others then
  return false;
end $$;
create policy "storage owner delete unpublished" on storage.objects for delete to authenticated
  using (bucket_id in ('uploads', 'artifacts') and public.has_client_role(public.storage_client(name), array['owner']) and public.storage_run_unlocked(name));
