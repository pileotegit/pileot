-- PILEOT Google Review Automation, V1: Einrichtung, Google-Abgleich, Wochenbericht, Betrieb
--
-- Gleiche Regeln wie in den vorherigen Migrationen: Tabellen im Schema review ohne API-Rechte,
-- öffentliche Funktionen rv_* nur für service_role.

-- ---------------------------------------------------------------------------
-- Tabellen
-- ---------------------------------------------------------------------------

alter table review.locations
  add constraint locations_google_location_id_format
    check (google_location_id is null or google_location_id ~ '^accounts/[0-9]+/locations/[0-9]+$'),
  add column google_last_sync_at timestamptz,
  add column google_last_sync_error text check (char_length(google_last_sync_error) <= 500);

-- Datensparsam: keine Namen, keine Bewertungstexte. Nur was der Bericht braucht.
create table review.google_reviews (
  tenant_id uuid not null,
  location_id uuid not null,
  review_id text not null check (char_length(review_id) between 1 and 200),
  star_rating smallint check (star_rating between 1 and 5),
  has_comment boolean not null default false,
  has_reply boolean not null default false,
  created_at_google timestamptz not null,
  updated_at_google timestamptz not null,
  first_seen_at timestamptz not null default now(),
  primary key (tenant_id, location_id, review_id),
  foreign key (tenant_id, location_id) references review.locations (tenant_id, id) on delete cascade
);
create index google_reviews_created_idx on review.google_reviews (tenant_id, created_at_google);

-- Ein Wochenbericht pro Mandant und Woche. week_start ist der Montag in Ortszeit.
create table review.report_runs (
  tenant_id uuid not null references review.tenants (id) on delete cascade,
  week_start date not null check (extract(isodow from week_start) = 1),
  status text not null default 'claimed' check (status in ('claimed', 'sent')),
  claimed_at timestamptz not null default now(),
  sent_at timestamptz,
  provider_message_id text,
  primary key (tenant_id, week_start)
);

alter table review.google_reviews enable row level security;
alter table review.report_runs enable row level security;

-- ---------------------------------------------------------------------------
-- Einrichtung (Runbook)
-- ---------------------------------------------------------------------------

-- Legt Mandant, Standort und Einstellungen in einem Schritt an. Sicher voreingestellt:
-- Mandant paused, Testmodus an. Freischalten erfolgt bewusst mit rv_set_tenant_status.
create function public.rv_setup_tenant(
  p_name text,
  p_location_name text,
  p_google_review_url text,
  p_sender_name text,
  p_sender_email text,
  p_reply_to_email text,
  p_report_recipient_email text,
  p_timezone text default 'Europe/Berlin',
  p_test_recipients text[] default '{}'
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_tenant uuid;
  v_location uuid;
begin
  insert into review.tenants (name, timezone) values (p_name, p_timezone) returning id into v_tenant;
  insert into review.locations (tenant_id, name, google_review_url)
  values (v_tenant, p_location_name, p_google_review_url) returning id into v_location;
  insert into review.tenant_settings (tenant_id, sender_name, sender_email, reply_to_email,
                                      report_recipient_email, test_recipients)
  values (v_tenant, p_sender_name, lower(btrim(p_sender_email)), lower(btrim(p_reply_to_email)),
          lower(btrim(p_report_recipient_email)),
          coalesce((select array_agg(lower(btrim(x))) from unnest(p_test_recipients) x), '{}'));
  return jsonb_build_object('tenant_id', v_tenant, 'location_id', v_location,
                            'status', 'paused', 'test_mode', true);
end
$$;

create function public.rv_set_test_mode(p_tenant_id uuid, p_test_mode boolean, p_test_recipients text[] default null)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  update review.tenant_settings
     set test_mode = p_test_mode,
         test_recipients = coalesce(
           (select array_agg(lower(btrim(x))) from unnest(p_test_recipients) x),
           case when p_test_recipients is null then test_recipients else '{}' end)
   where tenant_id = p_tenant_id;
  if not found then
    raise exception 'tenant not found';
  end if;
end
$$;

create function public.rv_set_google_location(p_location_id uuid, p_google_location_id text)
returns void
language sql security definer set search_path = ''
as $$
  update review.locations set google_location_id = p_google_location_id where id = p_location_id;
$$;

-- Manuelle Sperre (z. B. Kundin bittet telefonisch um keine weiteren E-Mails).
create function public.rv_suppress_manual(p_tenant_id uuid, p_email text)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  perform review.suppress_email(p_tenant_id, p_email, 'manual');
end
$$;

-- ---------------------------------------------------------------------------
-- Workflow D: Google-Abgleich
-- ---------------------------------------------------------------------------

create function public.rv_list_google_locations()
returns table (tenant_id uuid, location_id uuid, google_location_id text, last_sync_at timestamptz)
language sql security definer stable set search_path = ''
as $$
  select l.tenant_id, l.id, l.google_location_id, l.google_last_sync_at
    from review.locations l
    join review.tenants t on t.id = l.tenant_id
   where l.google_location_id is not null and l.status = 'active' and t.status = 'active'
   order by l.google_last_sync_at nulls first;
$$;

-- p_reviews: Array von Objekten {review_id, star_rating (1..5|null), has_comment, has_reply,
-- created_at, updated_at}. Idempotent: wiederholter Abgleich verändert nur geänderte Zeilen.
create function public.rv_upsert_google_reviews(p_location_id uuid, p_reviews jsonb)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_tenant uuid;
  v_inserted int := 0;
  v_updated int := 0;
  r jsonb;
  v_was_insert boolean;
begin
  select tenant_id into v_tenant from review.locations where id = p_location_id;
  if v_tenant is null then
    raise exception 'location not found';
  end if;
  if jsonb_typeof(p_reviews) <> 'array' then
    raise exception 'reviews must be an array';
  end if;

  for r in select * from jsonb_array_elements(p_reviews) loop
    insert into review.google_reviews as g
      (tenant_id, location_id, review_id, star_rating, has_comment, has_reply, created_at_google, updated_at_google)
    values (v_tenant, p_location_id, r ->> 'review_id', (r ->> 'star_rating')::smallint,
            coalesce((r ->> 'has_comment')::boolean, false), coalesce((r ->> 'has_reply')::boolean, false),
            (r ->> 'created_at')::timestamptz, (r ->> 'updated_at')::timestamptz)
    on conflict (tenant_id, location_id, review_id) do update
      set star_rating = excluded.star_rating, has_comment = excluded.has_comment,
          has_reply = excluded.has_reply, updated_at_google = excluded.updated_at_google
      where g.updated_at_google is distinct from excluded.updated_at_google
         or g.star_rating is distinct from excluded.star_rating
         or g.has_reply is distinct from excluded.has_reply
         or g.has_comment is distinct from excluded.has_comment
    returning (xmax = 0) into v_was_insert;
    if v_was_insert is true then
      v_inserted := v_inserted + 1;
    elsif v_was_insert is false then
      v_updated := v_updated + 1;
    end if;
    v_was_insert := null;
  end loop;

  update review.locations set google_last_sync_at = now(), google_last_sync_error = null where id = p_location_id;
  return jsonb_build_object('inserted', v_inserted, 'updated', v_updated);
end
$$;

create function public.rv_mark_google_sync_error(p_location_id uuid, p_error text)
returns void
language sql security definer set search_path = ''
as $$
  update review.locations set google_last_sync_error = left(p_error, 500) where id = p_location_id;
$$;

-- ---------------------------------------------------------------------------
-- Workflow E: Wochenbericht
-- ---------------------------------------------------------------------------

-- Kennzahlen der Woche [p_week_start 00:00, +7 Tage 00:00) in der Mandantenzeitzone.
-- Die Grenzen werden in Ortszeit gebildet und erst dann nach UTC umgerechnet, damit Wochen
-- mit Sommerzeitwechsel korrekt 167 oder 169 Stunden lang sind.
create function review.weekly_report(p_tenant_id uuid, p_week_start date)
returns jsonb
language plpgsql stable set search_path = ''
as $$
declare
  v_tz text;
  v_from timestamptz;
  v_to timestamptz;
  v_out jsonb;
begin
  select timezone into v_tz from review.tenants where id = p_tenant_id;
  v_from := p_week_start::timestamp at time zone v_tz;
  v_to := (p_week_start + 7)::timestamp at time zone v_tz;

  select jsonb_build_object(
    'week_start', p_week_start,
    'week_end', p_week_start + 6,
    'timezone', v_tz,
    'from_utc', v_from,
    'to_utc', v_to,
    'completions', (select count(*) from review.completion_events e
                     where e.tenant_id = p_tenant_id and e.received_at >= v_from and e.received_at < v_to),
    'initial_sent', (select count(*) from review.send_jobs j
                      where j.tenant_id = p_tenant_id and j.kind = 'initial' and j.status = 'sent'
                        and j.sent_at >= v_from and j.sent_at < v_to),
    'reminders_sent', (select count(*) from review.send_jobs j
                        where j.tenant_id = p_tenant_id and j.kind = 'reminder' and j.status = 'sent'
                          and j.sent_at >= v_from and j.sent_at < v_to),
    'delivered', (select count(distinct p.job_id) from review.provider_events p
                   where p.tenant_id = p_tenant_id and p.event_type = 'delivered'
                     and p.occurred_at >= v_from and p.occurred_at < v_to),
    'bounced', (select count(distinct p.job_id) from review.provider_events p
                 where p.tenant_id = p_tenant_id and p.event_type = 'bounced_hard'
                   and p.occurred_at >= v_from and p.occurred_at < v_to),
    'complaints', (select count(distinct p.job_id) from review.provider_events p
                    where p.tenant_id = p_tenant_id and p.event_type = 'complained'
                      and p.occurred_at >= v_from and p.occurred_at < v_to),
    'unsubscribes', (select count(*) from review.suppressions s
                      where s.tenant_id = p_tenant_id and s.reason = 'unsubscribe'
                        and s.created_at >= v_from and s.created_at < v_to),
    'qualified_clicks', (select count(distinct c.campaign_id) from review.click_events c
                          where c.tenant_id = p_tenant_id and c.click_class = 'qualified'
                            and c.occurred_at >= v_from and c.occurred_at < v_to),
    'dry_runs', (select count(*) from review.send_jobs j
                  where j.tenant_id = p_tenant_id and j.status = 'dry_run'
                    and j.updated_at >= v_from and j.updated_at < v_to),
    'failed', (select count(*) from review.send_jobs j
                where j.tenant_id = p_tenant_id and j.status = 'failed'
                  and j.updated_at >= v_from and j.updated_at < v_to),
    'open_unknown', (select count(*) from review.send_jobs j
                      where j.tenant_id = p_tenant_id and j.status = 'unknown'),
    'google', (
      select jsonb_build_object(
        'enabled', count(*) filter (where l.google_location_id is not null) > 0,
        'last_sync_at', max(l.google_last_sync_at),
        'new_reviews', (select count(*) from review.google_reviews g
                         where g.tenant_id = p_tenant_id
                           and g.created_at_google >= v_from and g.created_at_google < v_to),
        'avg_rating_new', (select round(avg(g.star_rating)::numeric, 2) from review.google_reviews g
                            where g.tenant_id = p_tenant_id
                              and g.created_at_google >= v_from and g.created_at_google < v_to),
        'total_reviews', (select count(*) from review.google_reviews g where g.tenant_id = p_tenant_id)
      )
      from review.locations l where l.tenant_id = p_tenant_id
    ),
    'test_mode', (select s.test_mode from review.tenant_settings s where s.tenant_id = p_tenant_id),
    'tenant_status', (select t.status from review.tenants t where t.id = p_tenant_id)
  ) into v_out;
  return v_out;
end
$$;

-- Reserviert die fälligen Berichte der Vorwoche (eine Zeile pro Mandant und Woche).
-- Bereits gesendete Berichte kommen nie wieder. Eine Reservierung, deren Versand nicht
-- bestätigt wurde, wird nach 30 Minuten erneut ausgegeben; der Versand nutzt einen festen
-- Idempotenzschlüssel, sodass der Provider einen Doppelversand innerhalb von 24 h verhindert.
create function public.rv_claim_weekly_reports(p_now timestamptz default now())
returns table (
  tenant_id uuid, week_start date, idempotency_key text, recipient text, sender_name text,
  sender_email text, reply_to_email text, tenant_name text, report jsonb
)
language plpgsql security definer set search_path = ''
as $$
#variable_conflict use_column
declare
  r record;
  v_week date;
  v_claimed boolean;
begin
  for r in
    select t.id as tid, t.name as tname, t.timezone as tz,
           s.report_recipient_email, s.sender_name as sname, s.sender_email as semail, s.reply_to_email as sreply
      from review.tenants t
      join review.tenant_settings s on s.tenant_id = t.id
     where t.status = 'active'
  loop
    v_week := (date_trunc('week', p_now at time zone r.tz))::date - 7;

    insert into review.report_runs as rr (tenant_id, week_start, claimed_at)
    values (r.tid, v_week, p_now)
    on conflict (tenant_id, week_start) do update
      set claimed_at = excluded.claimed_at
      where rr.status = 'claimed' and rr.claimed_at < p_now - interval '30 minutes'
    returning true into v_claimed;

    if v_claimed then
      tenant_id := r.tid; week_start := v_week;
      idempotency_key := 'rv-report-' || r.tid::text || '-' || v_week::text;
      recipient := r.report_recipient_email; sender_name := r.sname;
      sender_email := r.semail; reply_to_email := r.sreply; tenant_name := r.tname;
      report := review.weekly_report(r.tid, v_week);
      return next;
    end if;
    v_claimed := null;
  end loop;
end
$$;

create function public.rv_complete_weekly_report(p_tenant_id uuid, p_week_start date, p_provider_message_id text)
returns boolean
language sql security definer set search_path = ''
as $$
  update review.report_runs
     set status = 'sent', sent_at = now(), provider_message_id = p_provider_message_id
   where tenant_id = p_tenant_id and week_start = p_week_start and status = 'claimed'
  returning true;
$$;

-- Für Tests und Nachfragen: Bericht einer beliebigen Woche ansehen, ohne etwas zu reservieren.
create function public.rv_weekly_report_preview(p_tenant_id uuid, p_week_start date)
returns jsonb
language sql security definer stable set search_path = ''
as $$ select review.weekly_report(p_tenant_id, p_week_start) $$;

-- ---------------------------------------------------------------------------
-- Workflow F: Betrieb
-- ---------------------------------------------------------------------------

create function public.rv_ops_health(p_now timestamptz default now())
returns jsonb
language plpgsql security definer stable set search_path = ''
as $$
declare
  v_paused boolean;
  v_pause_reason text;
  v_unknown int;
  v_overdue int;
  v_failed int;
  v_sent7 int;
  v_bounced7 int;
  v_complaints7 int;
  v_google_errors int;
  v_alerts jsonb := '[]'::jsonb;
begin
  select send_paused, pause_reason into v_paused, v_pause_reason from review.system_settings where id;
  if v_pause_reason is not null then
    v_alerts := v_alerts || jsonb_build_object('code', 'auto_paused', 'count', 1,
      'hint', 'Versand automatisch pausiert (' || v_pause_reason || '). API-Key und Absenderdomain prüfen, dann rv_set_global_send_paused(false).');
  end if;
  select count(*) into v_unknown from review.send_jobs where status = 'unknown';
  -- Überfällig nur, wenn der Mandant gerade im Versandfenster ist: Jobs, die nachts fällig
  -- werden, warten planmäßig bis zum nächsten Fenster.
  select count(*) into v_overdue
    from review.send_jobs j
    join review.tenants t on t.id = j.tenant_id
    join review.tenant_settings s on s.tenant_id = j.tenant_id
   where j.status = 'queued' and j.due_at < p_now - interval '2 hours' and t.status = 'active'
     and review.next_send_slot(p_now, t.timezone, s.send_window_start, s.send_window_end, s.send_weekdays) = p_now
     and review.next_send_slot(p_now - interval '2 hours', t.timezone, s.send_window_start, s.send_window_end, s.send_weekdays)
         = p_now - interval '2 hours';
  select count(*) into v_failed from review.send_jobs where status = 'failed' and updated_at > p_now - interval '24 hours';
  select count(*) into v_sent7 from review.send_jobs where status = 'sent' and sent_at > p_now - interval '7 days';
  select count(distinct job_id) into v_bounced7 from review.provider_events
   where event_type = 'bounced_hard' and occurred_at > p_now - interval '7 days';
  select count(distinct job_id) into v_complaints7 from review.provider_events
   where event_type = 'complained' and occurred_at > p_now - interval '7 days';
  select count(*) into v_google_errors from review.locations where google_last_sync_error is not null;

  if v_unknown > 0 then
    v_alerts := v_alerts || jsonb_build_object('code', 'unknown_jobs', 'count', v_unknown,
      'hint', 'Versandausgang unklar. Im Resend-Dashboard prüfen und rv_resolve_unknown_job aufrufen.');
  end if;
  if v_overdue > 0 and not v_paused then
    v_alerts := v_alerts || jsonb_build_object('code', 'overdue_jobs', 'count', v_overdue,
      'hint', 'Fällige Jobs werden nicht abgearbeitet. Läuft Workflow B?');
  end if;
  if v_failed > 0 then
    v_alerts := v_alerts || jsonb_build_object('code', 'failed_jobs_24h', 'count', v_failed,
      'hint', 'Versand dauerhaft fehlgeschlagen. Absenderdomain und API-Key prüfen.');
  end if;
  if v_complaints7 > 0 then
    v_alerts := v_alerts || jsonb_build_object('code', 'complaints_7d', 'count', v_complaints7,
      'hint', 'Spam-Beschwerde. Versand pausieren und Grundlage prüfen.');
  end if;
  if v_sent7 >= 20 and v_bounced7::numeric / v_sent7 > 0.04 then
    v_alerts := v_alerts || jsonb_build_object('code', 'bounce_rate_7d', 'count', v_bounced7,
      'hint', 'Bounce-Rate über 4 %. Datenqualität der Adressen prüfen.');
  end if;
  if v_google_errors > 0 then
    v_alerts := v_alerts || jsonb_build_object('code', 'google_sync_errors', 'count', v_google_errors,
      'hint', 'Google-Abgleich fehlgeschlagen. Token und API-Freigabe prüfen.');
  end if;

  return jsonb_build_object(
    'checked_at', p_now,
    'send_paused', v_paused,
    'pause_reason', v_pause_reason,
    'unknown_jobs', v_unknown,
    'overdue_jobs', v_overdue,
    'failed_24h', v_failed,
    'sent_7d', v_sent7,
    'bounced_7d', v_bounced7,
    'complaints_7d', v_complaints7,
    'tenants', (select coalesce(jsonb_agg(jsonb_build_object(
                   'id', t.id, 'name', t.name, 'status', t.status, 'test_mode', s.test_mode) order by t.name), '[]')
                  from review.tenants t left join review.tenant_settings s on s.tenant_id = t.id),
    'alerts', v_alerts
  );
end
$$;

-- Aufbewahrung: Kontakte, deren Kampagnen beendet sind und die älter als retention_days sind,
-- werden gelöscht (inklusive Ereignissen, Jobs und Tokens). Sperren bleiben bestehen.
create function public.rv_purge_expired(p_now timestamptz default now())
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_contacts int;
begin
  with doomed as (
    select k.tenant_id, k.id
      from review.contacts k
      join review.tenant_settings s on s.tenant_id = k.tenant_id
     where k.created_at < p_now - make_interval(days => s.retention_days)
       and not exists (select 1 from review.campaigns c
                        where c.tenant_id = k.tenant_id and c.contact_id = k.id
                          and (c.status = 'active' or c.created_at >= p_now - make_interval(days => s.retention_days)))
  )
  delete from review.contacts k using doomed d where k.tenant_id = d.tenant_id and k.id = d.id;
  get diagnostics v_contacts = row_count;
  return jsonb_build_object('contacts_deleted', v_contacts);
end
$$;

-- ---------------------------------------------------------------------------
-- Rechte
-- ---------------------------------------------------------------------------

do $$
declare
  f record;
  r text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on all tables in schema review from %I', r);
      execute format('revoke all on all functions in schema review from %I', r);
    end if;
  end loop;

  for f in
    select p.oid::regprocedure as sig
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname like 'rv\_%'
  loop
    execute format('revoke all on function %s from public', f.sig);
    foreach r in array array['anon', 'authenticated'] loop
      if exists (select 1 from pg_roles where rolname = r) then
        execute format('revoke all on function %s from %I', f.sig, r);
      end if;
    end loop;
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('grant execute on function %s to service_role', f.sig);
    end if;
  end loop;
end
$$;
revoke all on all functions in schema review from public;
