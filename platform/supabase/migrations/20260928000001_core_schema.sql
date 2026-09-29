-- SOC-RAP production schema (spec v2.0 §8.2) on Supabase Postgres.
-- Access model:
--   * profiles.is_admin: platform administrators (all clients, users, purge).
--   * client_members.role per client: owner (reporting owner: runs, publish, SLA and rule configuration),
--     reviewer (resolves exceptions), viewer (read-only).
-- Published runs, threshold versions and published rule sets are immutable; every edit is audited.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- profiles
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  full_name text not null default '' check (char_length(full_name) <= 120),
  is_admin boolean not null default false,
  created_at timestamptz not null default now()
);
comment on table public.profiles is 'One row per signed-in user. The first user to sign up becomes an administrator.';

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, email, full_name, is_admin)
  values (
    new.id,
    coalesce(new.email, ''),
    left(coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name', ''), 120),
    not exists (select 1 from public.profiles)
  );
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------- clients and membership
create table public.clients (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 80),
  period_tz text not null default 'UTC',
  display_tz text not null default 'Asia/Kolkata',
  default_cadence text not null default 'monthly' check (default_cadence in ('weekly', 'monthly', 'custom')),
  source_label text not null default 'Google SecOps' check (char_length(source_label) <= 80),
  -- ackZero, uncategorizedWarnPct, materiality {minAbs,minPct,concentrationPct}, report text overrides
  settings jsonb not null default '{}'::jsonb check (jsonb_typeof(settings) = 'object'),
  created_by uuid references auth.users (id) default auth.uid(),
  created_at timestamptz not null default now(),
  archived_at timestamptz
);
create unique index clients_name_key on public.clients (lower(btrim(name)));

create table public.client_members (
  client_id uuid not null references public.clients (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null check (role in ('owner', 'reviewer', 'viewer')),
  added_by uuid references auth.users (id) default auth.uid(),
  added_at timestamptz not null default now(),
  primary key (client_id, user_id)
);
create index client_members_user_idx on public.client_members (user_id);

-- Authorization helpers. SECURITY DEFINER so policies can consult membership without recursive RLS.
create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select p.is_admin from public.profiles p where p.id = auth.uid()), false)
$$;

create or replace function public.has_client_role(cid uuid, roles text[])
returns boolean language sql stable security definer set search_path = '' as $$
  select public.is_admin() or exists (
    select 1 from public.client_members m where m.client_id = cid and m.user_id = auth.uid() and m.role = any (roles)
  )
$$;

create or replace function public.can_read_client(cid uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.has_client_role(cid, array['owner', 'reviewer', 'viewer'])
$$;

-- ---------------------------------------------------------------- audit log
create table public.audit_log (
  id bigint generated always as identity primary key,
  client_id uuid references public.clients (id) on delete set null,
  actor uuid default auth.uid(),
  action text not null check (char_length(action) <= 80),
  entity text not null check (char_length(entity) <= 40),
  entity_id text,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index audit_log_client_idx on public.audit_log (client_id, created_at desc);

create or replace function public.log_event(p_client uuid, p_action text, p_entity text, p_entity_id text, p_detail jsonb)
returns void language sql security definer set search_path = '' as $$
  insert into public.audit_log (client_id, actor, action, entity, entity_id, detail)
  values (p_client, auth.uid(), p_action, p_entity, p_entity_id, coalesce(p_detail, '{}'::jsonb))
$$;
revoke all on function public.log_event(uuid, text, text, text, jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------- SLA threshold versions (immutable)
create table public.threshold_versions (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete cascade,
  version_no integer not null,
  label text not null check (char_length(label) between 1 and 80),
  effective_from date not null default current_date,
  -- {"Critical":{"TTA":{"value":30,"unit":"min","seconds":1800},...},...}
  limits jsonb not null check (jsonb_typeof(limits) = 'object'),
  -- {"Critical":{"TTA":98,...},...}
  targets jsonb not null check (jsonb_typeof(targets) = 'object'),
  notes text not null default '' check (char_length(notes) <= 2000),
  published_by uuid references auth.users (id) default auth.uid(),
  created_at timestamptz not null default now(),
  unique (client_id, version_no)
);

-- Server-side validation of limits and targets (spec §4.2): every priority × metric present,
-- seconds = value × unit, whole seconds from 1 s to 30 days, targets 0–100 with one decimal.
create or replace function public.validate_thresholds(p_limits jsonb, p_targets jsonb)
returns void language plpgsql immutable set search_path = '' as $$
declare p text; m text; c jsonb; secs numeric; mult numeric; t numeric;
begin
  foreach p in array array['Critical', 'High', 'Medium', 'Low'] loop
    foreach m in array array['TTA', 'TTI', 'TTC', 'TTR'] loop
      c := p_limits -> p -> m;
      if c is null or jsonb_typeof(c -> 'value') <> 'number' or jsonb_typeof(c -> 'seconds') <> 'number' then
        raise exception 'Limit for % % is missing', p, m using errcode = '22023';
      end if;
      mult := case c ->> 'unit' when 's' then 1 when 'min' then 60 when 'h' then 3600 else null end;
      if mult is null then raise exception 'Unit for % % must be s, min or h', p, m using errcode = '22023'; end if;
      secs := (c ->> 'seconds')::numeric;
      if secs <> round((c ->> 'value')::numeric * mult) or secs <> trunc(secs) or secs < 1 or secs > 2592000 then
        raise exception 'Limit for % % must be a whole number of seconds from 1 to 2,592,000', p, m using errcode = '22023';
      end if;
      if jsonb_typeof(p_targets -> p -> m) <> 'number' then raise exception 'Target for % % is missing', p, m using errcode = '22023'; end if;
      t := (p_targets -> p ->> m)::numeric;
      if t < 0 or t > 100 or t * 10 <> trunc(t * 10) then
        raise exception 'Target for % % must be 0–100 with at most one decimal', p, m using errcode = '22023';
      end if;
    end loop;
  end loop;
end $$;

create or replace function public.threshold_versions_before_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform public.validate_thresholds(new.limits, new.targets);
  perform pg_advisory_xact_lock(hashtext('thr:' || new.client_id::text));
  select coalesce(max(version_no), 0) + 1 into new.version_no from public.threshold_versions where client_id = new.client_id;
  new.published_by := coalesce(auth.uid(), new.published_by);
  new.created_at := now();
  return new;
end $$;
create trigger threshold_versions_bi before insert on public.threshold_versions for each row execute function public.threshold_versions_before_insert();

create or replace function public.threshold_versions_after_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform public.log_event(new.client_id, 'SLA thresholds saved', 'threshold_version', new.id::text,
    jsonb_build_object('version_no', new.version_no, 'label', new.label, 'effective_from', new.effective_from));
  return null;
end $$;
create trigger threshold_versions_ai after insert on public.threshold_versions for each row execute function public.threshold_versions_after_insert();

-- ---------------------------------------------------------------- category rule sets
create table public.ruleset_versions (
  id uuid primary key default gen_random_uuid(),
  client_id uuid references public.clients (id) on delete cascade, -- null = global baseline
  version_no integer,
  label text not null check (char_length(label) between 1 and 80),
  status text not null default 'draft' check (status in ('draft', 'published')),
  rules jsonb not null check (jsonb_typeof(rules) = 'array'),
  notes text not null default '' check (char_length(notes) <= 2000),
  effective_from date,
  -- regression result and category-movement diff shown before publish (spec §4.3.6)
  publish_check jsonb,
  based_on uuid references public.ruleset_versions (id) on delete set null,
  created_by uuid references auth.users (id) default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  published_by uuid references auth.users (id),
  published_at timestamptz
);
create unique index ruleset_one_draft on public.ruleset_versions (coalesce(client_id, '00000000-0000-0000-0000-000000000000'::uuid)) where status = 'draft';
create unique index ruleset_version_no on public.ruleset_versions (coalesce(client_id, '00000000-0000-0000-0000-000000000000'::uuid), version_no) where version_no is not null;

create or replace function public.ruleset_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if old.status = 'published' and coalesce(current_setting('app.purging', true), '') <> 'on' then
      raise exception 'A published rule set is immutable' using errcode = '42501';
    end if;
    return old;
  end if;
  if tg_op = 'UPDATE' then
    if old.status = 'published' then raise exception 'A published rule set is immutable' using errcode = '42501'; end if;
    if new.client_id is distinct from old.client_id then raise exception 'A rule set cannot move between clients' using errcode = '42501'; end if;
  end if;
  if jsonb_array_length(new.rules) > 1000 then raise exception 'A rule set can hold at most 1,000 rules' using errcode = '22023'; end if;
  new.updated_at := now();
  if new.status = 'published' and (tg_op = 'INSERT' or old.status = 'draft') then
    perform pg_advisory_xact_lock(hashtext('rs:' || coalesce(new.client_id::text, 'global')));
    select coalesce(max(version_no), 0) + 1 into new.version_no from public.ruleset_versions
      where client_id is not distinct from new.client_id and version_no is not null;
    new.published_by := coalesce(auth.uid(), new.published_by);
    new.published_at := now();
    new.effective_from := coalesce(new.effective_from, current_date);
    perform public.log_event(new.client_id, 'Rule set published', 'ruleset_version', new.id::text,
      jsonb_build_object('version_no', new.version_no, 'label', new.label, 'rules', jsonb_array_length(new.rules)));
  end if;
  return new;
end $$;
create trigger ruleset_guard_iu before insert or update on public.ruleset_versions for each row execute function public.ruleset_guard();
create trigger ruleset_guard_d before delete on public.ruleset_versions for each row execute function public.ruleset_guard();

-- ---------------------------------------------------------------- column-mapping profiles
create table public.column_profiles (
  client_id uuid primary key references public.clients (id) on delete cascade,
  mapping jsonb not null check (jsonb_typeof(mapping) = 'object'),
  headers text[] not null default '{}',
  updated_by uuid references auth.users (id) default auth.uid(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- runs
create table public.runs (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete cascade,
  cadence text not null check (cadence in ('weekly', 'monthly', 'custom')),
  period_start date not null,
  period_end date not null,
  status text not null default 'draft' check (status in ('draft', 'staged', 'review', 'published', 'superseded')),
  threshold_version_id uuid references public.threshold_versions (id),
  ruleset_version_id uuid references public.ruleset_versions (id),
  source_file_name text check (char_length(source_file_name) <= 255),
  source_file_path text check (char_length(source_file_path) <= 512),
  source_file_hash text check (source_file_hash ~ '^[0-9a-f]{64}$'),
  source_file_size bigint,
  source_sheet text,
  row_count integer not null default 0,
  column_map jsonb,
  -- engine settings snapshot: period_tz, display_tz, ackZero, engine_version
  settings jsonb not null default '{}'::jsonb,
  -- readiness counts and headline compliance, refreshed on every recalculation
  summary jsonb not null default '{}'::jsonb,
  -- full aggregate at publish (breakdowns, heat, daily) for dashboards and exports
  aggregate jsonb,
  observations jsonb,
  report_text jsonb not null default '{}'::jsonb,
  supersedes_run_id uuid references public.runs (id) on delete set null,
  created_by uuid references auth.users (id) default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  published_by uuid references auth.users (id),
  published_at timestamptz,
  check (period_end >= period_start and period_end - period_start <= 366)
);
create index runs_client_period_idx on public.runs (client_id, period_start desc);
create index runs_hash_idx on public.runs (client_id, source_file_hash);

-- Status moves forward only; published runs are locked except for being superseded.
create or replace function public.runs_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  -- A purge nulls supersedes_run_id on later runs through the foreign key; allow that.
  if coalesce(current_setting('app.purging', true), '') = 'on' then return new; end if;
  if tg_op = 'UPDATE' then
    if old.status in ('published', 'superseded') then
      if coalesce(current_setting('app.run_publish', true), '') = 'on' then return new; end if;
      raise exception 'This run is published and locked. Re-run the period to change it.' using errcode = '42501';
    end if;
    if new.status = 'published' and coalesce(current_setting('app.run_publish', true), '') <> 'on' then
      raise exception 'Use publish_run() to publish' using errcode = '42501';
    end if;
    if new.client_id <> old.client_id or new.created_by is distinct from old.created_by then
      raise exception 'Run ownership cannot change' using errcode = '42501';
    end if;
    new.updated_at := now();
  elsif tg_op = 'INSERT' then
    if new.status not in ('draft') then raise exception 'New runs start as draft' using errcode = '42501'; end if;
    new.created_by := auth.uid();
    new.created_at := now();
  end if;
  return new;
end $$;
create trigger runs_guard before insert or update on public.runs for each row execute function public.runs_guard();

-- ---------------------------------------------------------------- case data
create table public.case_raw (
  run_id uuid not null references public.runs (id) on delete cascade,
  row_no integer not null,
  payload jsonb not null,
  primary key (run_id, row_no)
);
comment on table public.case_raw is 'The uploaded rows exactly as read. Never updated; removed only with the run.';

create table public.case_derived (
  run_id uuid not null references public.runs (id) on delete cascade,
  row_no integer not null,
  case_id text not null default '',
  title text not null default '',
  title_normalized text not null default '',
  category text not null,
  subcategory text not null default '',
  report_bucket text not null,
  matched_rule_id text not null,
  matched_text text not null default '',
  priority text check (priority in ('Critical', 'High', 'Medium', 'Low', 'Informational')),
  prio_note text not null default '',
  created_at timestamptz,
  assigned_at timestamptz,
  investigated_till timestamptz,
  containment_at timestamptz,
  closed_at timestamptz,
  disposition text not null default '',
  close_reason text not null default '',
  root_cause text not null default '',
  assignee text not null default '',
  stage text not null default '',
  is_open boolean not null default false,
  in_period boolean not null default true,
  excluded boolean not null default false,
  excluded_reason text not null default '',
  tta_sec numeric, tti_sec numeric, ttc_sec numeric, ttr_sec numeric,
  tta_status text, tti_status text, ttc_status text, ttr_status text,
  tta_note text, tti_note text, ttc_note text, ttr_note text,
  tta_imputed boolean not null default false,
  dq_note text not null default '',
  primary key (run_id, row_no),
  check (tta_status in ('MET', 'NOT_MET', 'PENDING', 'NA', 'ERROR') and tti_status in ('MET', 'NOT_MET', 'PENDING', 'NA', 'ERROR')
     and ttc_status in ('MET', 'NOT_MET', 'PENDING', 'NA', 'ERROR') and ttr_status in ('MET', 'NOT_MET', 'PENDING', 'NA', 'ERROR'))
);
create index case_derived_created_idx on public.case_derived (run_id, created_at);
create index case_derived_case_idx on public.case_derived (run_id, case_id);

-- Review decisions = the edit audit (spec §8.2 edit_audit). Append-only; the latest decision per key applies.
create table public.case_edits (
  id bigint generated always as identity primary key,
  run_id uuid not null references public.runs (id) on delete cascade,
  kind text not null check (kind in ('priority', 'timestamp', 'void_metric', 'drop', 'restore', 'category', 'accept', 'period')),
  row_no integer,
  case_id text,
  target_key text,
  field text,
  old_value jsonb,
  new_value jsonb,
  reason text not null default '' check (char_length(reason) <= 1000),
  actor uuid references auth.users (id) default auth.uid(),
  created_at timestamptz not null default now()
);
create index case_edits_run_idx on public.case_edits (run_id, id);

create table public.exceptions (
  run_id uuid not null references public.runs (id) on delete cascade,
  key text not null,
  type text not null,
  severity text not null check (severity in ('blocking', 'non_blocking')),
  status text not null check (status in ('open', 'accepted', 'resolved')),
  case_count integer not null default 0,
  rows integer[] not null default '{}',
  detail jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (run_id, key)
);

create table public.metric_snapshots (
  run_id uuid not null references public.runs (id) on delete cascade,
  priority text not null check (priority in ('Critical', 'High', 'Medium', 'Low', 'All')),
  metric text not null check (metric in ('TTA', 'TTI', 'TTC', 'TTR')),
  met integer not null, not_met integer not null, pending integer not null, na integer not null, data_error integer not null,
  zero_imputed integer not null default 0,
  compliance_pct numeric, target_pct numeric, variance_pts numeric,
  status text not null check (status in ('ok', 'bad', 'none')),
  mean_sec numeric, median_sec numeric, p95_sec numeric,
  worst jsonb not null default '[]'::jsonb,
  primary key (run_id, priority, metric)
);

create table public.run_artifacts (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.runs (id) on delete cascade,
  kind text not null check (kind in ('workbook', 'exceptions', 'deck', 'slide_tables', 'heatmap_png', 'heatmap_csv', 'cases_csv')),
  file_path text not null,
  file_name text not null,
  size_bytes bigint,
  created_by uuid references auth.users (id) default auth.uid(),
  created_at timestamptz not null default now()
);
create index run_artifacts_run_idx on public.run_artifacts (run_id, created_at desc);

-- Child rows of a published run are frozen. Purge (admin) sets app.purging for the cascade.
create or replace function public.run_child_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
declare st text; rid uuid;
begin
  if coalesce(current_setting('app.purging', true), '') = 'on' then return coalesce(new, old); end if;
  rid := coalesce(new.run_id, old.run_id);
  select status into st from public.runs where id = rid;
  if st in ('published', 'superseded') and coalesce(current_setting('app.run_publish', true), '') <> 'on' then
    raise exception 'This run is published and locked' using errcode = '42501';
  end if;
  if tg_table_name = 'case_raw' and tg_op = 'UPDATE' then
    raise exception 'Uploaded rows are never changed' using errcode = '42501';
  end if;
  if tg_table_name = 'case_edits' and tg_op <> 'INSERT' then
    raise exception 'The edit log is append-only' using errcode = '42501';
  end if;
  return coalesce(new, old);
end $$;
create trigger case_raw_guard before insert or update or delete on public.case_raw for each row execute function public.run_child_guard();
create trigger case_derived_guard before insert or update or delete on public.case_derived for each row execute function public.run_child_guard();
create trigger case_edits_guard before insert or update or delete on public.case_edits for each row execute function public.run_child_guard();
create trigger exceptions_guard before insert or update or delete on public.exceptions for each row execute function public.run_child_guard();
create trigger metric_snapshots_guard before insert or update or delete on public.metric_snapshots for each row execute function public.run_child_guard();

create or replace function public.case_edits_before_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  new.actor := auth.uid();
  new.created_at := now();
  return new;
end $$;
create trigger case_edits_bi before insert on public.case_edits for each row execute function public.case_edits_before_insert();
