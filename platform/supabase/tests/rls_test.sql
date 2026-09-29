create table t_results (id serial primary key, name text, ok boolean, detail text);
grant all on t_results to authenticated; grant all on sequence t_results_id_seq to authenticated;
create table t_ctx (k text primary key, v uuid); grant all on t_ctx to authenticated;
create function t_ok(n text, cond boolean, d text default '') returns void language sql as $$ insert into t_results(name, ok, detail) values (n, coalesce(cond,false), d) $$;
create function t_err(n text, q text, pat text default '') returns void language plpgsql as $$
begin
  begin execute q; insert into t_results(name, ok, detail) values (n, false, 'no error raised');
  exception when others then insert into t_results(name, ok, detail) values (n, sqlerrm ilike '%' || pat || '%', sqlerrm); end;
end $$;
create function t_as(u text) returns void language plpgsql as $$ begin perform set_config('request.jwt.claim.sub', u, false); end $$;
create function v(k text) returns uuid language sql as $$ select v from t_ctx where t_ctx.k = $1 $$;
grant execute on all functions in schema public to authenticated;

insert into auth.users(id,email) values ('00000000-0000-0000-0000-00000000000a','a@x'),('00000000-0000-0000-0000-00000000000b','b@x'),('00000000-0000-0000-0000-00000000000c','c@x'),('00000000-0000-0000-0000-00000000000d','d@x');
select t_ok('first user is admin, others not', (select array_agg(is_admin order by email) from profiles) = array[true,false,false,false]);
select t_ok('global baseline rule set seeded', (select count(*) = 1 and min(jsonb_array_length(rules)) = 44 from ruleset_versions where client_id is null and status = 'published'));

set role authenticated;
select t_as('00000000-0000-0000-0000-00000000000b');
select t_err('non-admin cannot create client', $$insert into clients(name) values ('Nope')$$, 'row-level security');
select t_as('00000000-0000-0000-0000-00000000000a');
with x as (insert into clients(name) values ('Contoso') returning id) insert into t_ctx select 'client', id from x;
select t_ok('creator is owner', exists(select 1 from client_members where client_id = v('client') and role = 'owner'));
select t_ok('client got threshold v1 with baseline', (select version_no = 1 and label = 'SEP-2026-SLA-01' from threshold_versions where client_id = v('client')));
select t_ok('client got published rule set copy v1', (select version_no = 1 and status = 'published' and jsonb_array_length(rules) = 44 from ruleset_versions where client_id = v('client')));
select t_err('duplicate client name refused', $$insert into clients(name) values (' contoso ')$$, 'duplicate');
insert into client_members(client_id,user_id,role) values (v('client'),'00000000-0000-0000-0000-00000000000b','reviewer'),(v('client'),'00000000-0000-0000-0000-00000000000c','viewer');

select t_as('00000000-0000-0000-0000-00000000000d');
select t_ok('outsider sees no clients, runs, thresholds', (select count(*) from clients) = 0 and (select count(*) from threshold_versions) = 0);
select t_ok('outsider sees the global baseline only', (select count(*) from ruleset_versions) = 1);
select t_err('outsider cannot add self as member', format($$insert into client_members(client_id,user_id,role) values (%L,'00000000-0000-0000-0000-00000000000d','owner')$$, v('client')), 'row-level security');

select t_as('00000000-0000-0000-0000-00000000000c');
select t_ok('viewer sees client', (select count(*) from clients) = 1);
select t_err('viewer cannot create run', format($$insert into runs(client_id,cadence,period_start,period_end) values (%L,'monthly','2026-06-01','2026-06-30')$$, v('client')), 'row-level security');
select t_err('viewer cannot save thresholds', format($$insert into threshold_versions(client_id,version_no,label,limits,targets) values (%L,0,'x',default_limits(),default_targets())$$, v('client')), 'row-level security');

select t_as('00000000-0000-0000-0000-00000000000b');
select t_err('reviewer cannot create run', format($$insert into runs(client_id,cadence,period_start,period_end) values (%L,'monthly','2026-06-01','2026-06-30')$$, v('client')), 'row-level security');
select t_err('reviewer cannot grant self admin', $$update profiles set is_admin = true where id = auth.uid()$$, 'administrator');

select t_as('00000000-0000-0000-0000-00000000000a');
select t_err('invalid threshold refused (0.5 s)', format($$insert into threshold_versions(client_id,version_no,label,limits,targets) values (%L,0,'bad',jsonb_set(default_limits(),'{High,TTA}','{"value":0.5,"unit":"s","seconds":0.5}'),default_targets())$$, v('client')), 'whole number');
select t_err('invalid target refused (100.55)', format($$insert into threshold_versions(client_id,version_no,label,limits,targets) values (%L,0,'bad',default_limits(),jsonb_set(default_targets(),'{High,TTA}','100.55'))$$, v('client')), 'Target');
insert into threshold_versions(client_id,version_no,label,limits,targets) values (v('client'),0,'OCT',default_limits(),default_targets());
select t_ok('threshold versions number themselves', (select max(version_no) from threshold_versions where client_id = v('client')) = 2);
update threshold_versions set label = 'x';
select t_ok('threshold update affected nothing', not exists(select 1 from threshold_versions where label = 'x'));
select t_err('published rule set immutable', format($$update ruleset_versions set label='x' where client_id = %L$$, v('client')), 'immutable');
insert into ruleset_versions(client_id,label,rules) values (v('client'),'draft', '[]');
select t_err('only one draft per client', format($$insert into ruleset_versions(client_id,label,rules) values (%L,'draft2','[]')$$, v('client')), 'duplicate');
update ruleset_versions set status = 'published', label = 'v2' where client_id = v('client') and status = 'draft';
select t_ok('publishing a draft numbers it v2', (select max(version_no) from ruleset_versions where client_id = v('client')) = 2);

with x as (insert into runs(client_id,cadence,period_start,period_end,threshold_version_id,ruleset_version_id)
  select v('client'),'monthly','2026-06-01','2026-06-30',(select id from threshold_versions where client_id=v('client') order by version_no desc limit 1),(select id from ruleset_versions where client_id=v('client') order by version_no desc limit 1) returning id) insert into t_ctx select 'run', id from x;
select t_err('run cannot start published', format($$insert into runs(client_id,cadence,period_start,period_end,status) values (%L,'monthly','2026-06-01','2026-06-30','published')$$, v('client')), 'draft');
insert into case_raw(run_id,row_no,payload) values (v('run'),2,'{"id":"1"}'),(v('run'),3,'{"id":"2"}');
update case_raw set payload = '{}';
select t_ok('raw rows are never updated (no update policy)', not exists(select 1 from case_raw where payload = '{}'));
reset role; select t_err('raw rows refuse updates even with RLS bypassed', $$update case_raw set payload = '{}'$$, 'never changed'); set role authenticated;
insert into case_derived(run_id,row_no,category,report_bucket,matched_rule_id,tta_status,tti_status,ttc_status,ttr_status) values (v('run'),2,'X','X','R','MET','MET','NA','MET');
update runs set status = 'review', summary = '{"blockingOpen":0}' where id = v('run');
insert into exceptions(run_id,key,type,severity,status,case_count) values (v('run'),'PRIO:3','PRIO','blocking','open',1);

select t_as('00000000-0000-0000-0000-00000000000b');
insert into case_edits(run_id,kind,row_no,new_value,reason) values (v('run'),'priority',3,'"High"','fixed');
select t_ok('reviewer edit recorded with actor', (select actor = '00000000-0000-0000-0000-00000000000b' from case_edits limit 1));
update case_edits set reason = 'x';
reset role; select t_err('edit log append-only even with RLS bypassed', $$update case_edits set reason = 'x'$$, 'append-only'); set role authenticated;
select t_ok('edit log update affected nothing', not exists(select 1 from case_edits where reason = 'x'));
select t_err('reviewer cannot publish', format($$select publish_run(%L)$$, v('run')), 'owner');
select t_err('reviewer cannot set status published directly', format($$update runs set status='published' where id=%L$$, v('run')), 'publish_run');

select t_as('00000000-0000-0000-0000-00000000000c');
select t_err('viewer cannot edit', format($$insert into case_edits(run_id,kind,row_no) values (%L,'priority',3)$$, v('run')), 'row-level security');

select t_as('00000000-0000-0000-0000-00000000000a');
select t_err('publish blocked by open blocking exception (AT-07)', format($$select publish_run(%L)$$, v('run')), 'blocking');
update exceptions set status = 'resolved' where run_id = v('run');
select t_err('publish blocked without snapshot', format($$select publish_run(%L)$$, v('run')), 'snapshot');
insert into metric_snapshots(run_id,priority,metric,met,not_met,pending,na,data_error,status) values (v('run'),'High','TTA',1,0,0,0,0,'ok');
select publish_run(v('run'));
select t_ok('run published', (select status = 'published' and published_by = auth.uid() from runs where id = v('run')));
select t_err('published run locked', format($$update runs set summary = '{}' where id = %L$$, v('run')), 'locked');
select t_err('published derived rows locked', $$update case_derived set category = 'Y'$$, 'locked');
select t_err('published edits locked', format($$insert into case_edits(run_id,kind,row_no) values (%L,'priority',3)$$, v('run')), 'locked');
delete from runs where id = v('run');
select t_ok('published run still there', exists(select 1 from runs where id = v('run')));

-- a second run for the same period supersedes the first on publish
with x as (insert into runs(client_id,cadence,period_start,period_end,threshold_version_id,ruleset_version_id)
  select client_id,cadence,period_start,period_end,threshold_version_id,ruleset_version_id from runs where id = v('run') returning id) insert into t_ctx select 'run2', id from x;
update runs set status='review', summary='{"blockingOpen":0}' where id = v('run2');
insert into metric_snapshots(run_id,priority,metric,met,not_met,pending,na,data_error,status) values (v('run2'),'High','TTA',1,0,0,0,0,'ok');
select publish_run(v('run2'));
select t_ok('earlier run superseded', (select status from runs where id = v('run')) = 'superseded' and (select supersedes_run_id from runs where id = v('run2')) = v('run'));

insert into storage.objects(bucket_id,name) values ('uploads', v('client')::text || '/' || v('run2')::text || '/file.xlsx');
select t_as('00000000-0000-0000-0000-00000000000c');
select t_ok('viewer can read uploads of own client', (select count(*) from storage.objects) = 1);
select t_err('viewer cannot upload', format($$insert into storage.objects(bucket_id,name) values ('uploads', %L)$$, v('client')::text || '/x/y.csv'), 'row-level security');
select t_as('00000000-0000-0000-0000-00000000000d');
select t_ok('outsider cannot see objects', (select count(*) from storage.objects) = 0);
select t_err('bad object path refused', $$insert into storage.objects(bucket_id,name) values ('uploads', 'not-a-uuid/x.csv')$$, 'row-level security');

select t_as('00000000-0000-0000-0000-00000000000b');
select t_err('non-admin cannot purge', format($$select purge_run(%L, 'retention policy')$$, v('run')), 'administrators');
select t_as('00000000-0000-0000-0000-00000000000a');
select t_err('purge needs a reason', format($$select purge_run(%L, '')$$, v('run')), 'reason');
select purge_run(v('run'), 'Retention: older than 13 months');
select t_ok('purged run and its rows gone', not exists(select 1 from runs where id = v('run')) and not exists(select 1 from case_raw where run_id = v('run')));
select t_ok('purge logged', exists(select 1 from audit_log where action = 'Run purged' and detail->>'reason' like 'Retention%'));
select t_ok('audit trail has run lifecycle', (select count(*) from audit_log where entity = 'run') >= 5);
select t_as('00000000-0000-0000-0000-00000000000d');
select t_ok('outsider sees no audit entries for the client', (select count(*) from audit_log where client_id is not null) = 0);
reset role;
-- storage deletes: owners only for unpublished runs
set role authenticated;
select t_as('00000000-0000-0000-0000-00000000000a');
with x as (insert into runs(client_id,cadence,period_start,period_end) select v('client'),'weekly','2026-06-01','2026-06-07' returning id) insert into t_ctx select 'run3', id from x;
reset role;
insert into storage.objects(bucket_id,name) values ('uploads', v('client')::text || '/' || v('run3')::text || '/draft.csv'), ('uploads', v('client')::text || '/' || v('run2')::text || '/pub.csv');
insert into client_members(client_id,user_id,role) values (v('client'),'00000000-0000-0000-0000-00000000000d','owner');
update profiles set is_admin = false where id = '00000000-0000-0000-0000-00000000000d';
set role authenticated;
select t_as('00000000-0000-0000-0000-00000000000d');
delete from storage.objects where name like '%/draft.csv';
delete from storage.objects where name like '%/pub.csv';
select t_ok('owner can delete files of an unpublished run', not exists(select 1 from storage.objects where name like '%/draft.csv'));
select t_ok('owner cannot delete files of a published run', exists(select 1 from storage.objects where name like '%/pub.csv'));
reset role;
