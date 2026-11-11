-- PILEOT Google Review Automation, V1: RPCs
--
-- Alle öffentlichen Funktionen (Präfix rv_) sind SECURITY DEFINER mit leerem search_path
-- und nur für service_role ausführbar. n8n und Edge Functions rufen sie mit dem
-- Service-Role-Key auf. Der Mandant wird nie aus einem Request-Feld übernommen, sondern
-- aus der verifizierten Integration (API-Key-Hash) abgeleitet.
--
-- Zustandsmodell send_jobs.status:
--   queued -> claimed -> sending -> sent | failed | unknown
--   claimed mit abgelaufener Lease: zurück nach queued (es wurde nie gesendet)
--   sending mit abgelaufener Lease: unknown (Ausgang unklar, NICHT blind erneut senden)
--   cancelled: durch Stopp (Abmeldung, Bounce, Beschwerde, Sperre, abgelaufen)
--   dry_run: Testmodus, Empfänger nicht freigegeben

-- ---------------------------------------------------------------------------
-- Interne Helfer
-- ---------------------------------------------------------------------------

create function review.stop_campaign(p_tenant_id uuid, p_campaign_id uuid, p_reason text)
returns void
language plpgsql set search_path = ''
as $$
begin
  update review.campaigns
     set status = 'stopped', end_reason = p_reason
   where tenant_id = p_tenant_id and id = p_campaign_id and status = 'active';

  update review.send_jobs
     set status = 'cancelled', claimed_by = null, lease_expires_at = null, updated_at = now()
   where tenant_id = p_tenant_id and campaign_id = p_campaign_id
     and status in ('queued', 'claimed');
end
$$;

-- Dauerhafte Sperre setzen und alle offenen Kampagnen dieser Adresse stoppen.
create function review.suppress_email(p_tenant_id uuid, p_email text, p_reason text)
returns void
language plpgsql set search_path = ''
as $$
declare
  r record;
begin
  insert into review.suppressions (tenant_id, email_hash, reason)
  values (p_tenant_id, review.email_hash(p_email), p_reason)
  on conflict (tenant_id, email_hash) do nothing;

  for r in
    select c.id
      from review.campaigns c
      join review.contacts k on k.tenant_id = c.tenant_id and k.id = c.contact_id
     where c.tenant_id = p_tenant_id and c.status = 'active'
       and k.email_normalized = lower(btrim(p_email))
  loop
    perform review.stop_campaign(p_tenant_id, r.id, p_reason);
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- Einrichtung und Betrieb
-- ---------------------------------------------------------------------------

-- Erzeugt einen API-Key für den Abschluss-Webhook. Der Klartext wird nur hier zurückgegeben.
create function public.rv_create_integration(p_tenant_id uuid, p_location_id uuid, p_source text)
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_key text := 'rvk_' || review.new_token();
begin
  insert into review.integrations (tenant_id, location_id, source, key_hash)
  values (p_tenant_id, p_location_id, p_source, review.token_hash(v_key));
  return v_key;
end
$$;

create function public.rv_set_global_send_paused(p_paused boolean)
returns void
language sql security definer set search_path = ''
as $$
  update review.system_settings set send_paused = p_paused, pause_reason = null, updated_at = now() where id;
$$;

create function public.rv_set_tenant_status(p_tenant_id uuid, p_status text)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if p_status not in ('active', 'paused') then
    raise exception 'invalid status';
  end if;
  update review.tenants set status = p_status where id = p_tenant_id;
end
$$;

-- ---------------------------------------------------------------------------
-- Workflow A: Abschluss aufnehmen
-- ---------------------------------------------------------------------------
-- Ergebnis immer als jsonb: result = created | duplicate | rejected, bei rejected mit reason.
-- Geschäftliche Ablehnungen werfen keine Exception.

create function public.rv_ingest_completion(
  p_api_key text,
  p_external_event_id text,
  p_external_contact_ref text,
  p_email text,
  p_first_name text,
  p_completed_at timestamptz,
  p_consent_basis text default null,
  p_consent_source text default null,
  p_consent_documented_at timestamptz default null
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_int review.integrations%rowtype;
  v_tenant review.tenants%rowtype;
  v_loc review.locations%rowtype;
  v_set review.tenant_settings%rowtype;
  v_email text;
  v_now timestamptz := now();
  v_existing_basis text;
  v_contact_id uuid;
  v_event_id uuid;
  v_campaign_id uuid;
  v_job_id uuid;
  v_due timestamptz;
begin
  if p_api_key is null or char_length(p_api_key) not between 20 and 200 then
    return jsonb_build_object('result', 'rejected', 'reason', 'integration_invalid');
  end if;

  select * into v_int
    from review.integrations
   where key_hash = review.token_hash(p_api_key) and revoked_at is null;
  if not found then
    return jsonb_build_object('result', 'rejected', 'reason', 'integration_invalid');
  end if;

  select * into v_tenant from review.tenants where id = v_int.tenant_id;
  select * into v_loc from review.locations where tenant_id = v_int.tenant_id and id = v_int.location_id;
  select * into v_set from review.tenant_settings where tenant_id = v_int.tenant_id;
  if v_set.tenant_id is null then
    return jsonb_build_object('result', 'rejected', 'reason', 'tenant_not_configured');
  end if;

  v_email := lower(btrim(coalesce(p_email, '')));
  if p_external_event_id is null or char_length(p_external_event_id) not between 1 and 128
     or p_external_contact_ref is null or char_length(p_external_contact_ref) not between 1 and 128
     or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or char_length(v_email) > 254
     or p_completed_at is null
     or char_length(coalesce(p_first_name, '')) > 80
     or char_length(coalesce(p_consent_source, '')) > 200
     or (p_consent_basis is not null and p_consent_basis not in ('explicit_opt_in', 'documented_other')) then
    return jsonb_build_object('result', 'rejected', 'reason', 'invalid_payload');
  end if;

  -- Replay- und Zeitgrenzen
  if p_completed_at > v_now + interval '5 minutes' then
    return jsonb_build_object('result', 'rejected', 'reason', 'future_event');
  end if;
  if p_completed_at < v_now - interval '7 days' then
    return jsonb_build_object('result', 'rejected', 'reason', 'stale_event');
  end if;

  if v_tenant.status <> 'active' then
    return jsonb_build_object('result', 'rejected', 'reason', 'tenant_paused');
  end if;
  if v_loc.status <> 'active' then
    return jsonb_build_object('result', 'rejected', 'reason', 'location_paused');
  end if;

  -- Wiederholter Webhook: bestehendes Ergebnis zurückgeben, nichts neu anlegen.
  select e.id into v_event_id
    from review.completion_events e
   where e.tenant_id = v_tenant.id and e.source = v_int.source and e.external_event_id = p_external_event_id;
  if found then
    select c.id into v_campaign_id from review.campaigns c where c.tenant_id = v_tenant.id and c.event_id = v_event_id;
    return jsonb_build_object('result', 'duplicate', 'campaign_id', v_campaign_id);
  end if;

  if exists (select 1 from review.suppressions s
              where s.tenant_id = v_tenant.id and s.email_hash = review.email_hash(v_email)) then
    return jsonb_build_object('result', 'rejected', 'reason', 'suppressed');
  end if;

  -- Versandgrundlage: aus dem Request oder bereits am Kontakt dokumentiert. Sonst nichts speichern.
  select k.consent_basis into v_existing_basis
    from review.contacts k
   where k.tenant_id = v_tenant.id and k.external_ref = p_external_contact_ref;
  if coalesce(p_consent_basis, v_existing_basis) is null then
    return jsonb_build_object('result', 'rejected', 'reason', 'no_consent');
  end if;
  if p_consent_basis is not null and (p_consent_source is null or p_consent_documented_at is null) then
    return jsonb_build_object('result', 'rejected', 'reason', 'invalid_payload');
  end if;

  -- Parallele Aufrufe für denselben Kontakt nacheinander abarbeiten. Ohne diese Sperre löst
  -- der Upsert bei gleichzeitigem Einfügen eine unique_violation auf (tenant_id, email_normalized)
  -- statt des erwarteten ON CONFLICT aus und würde fälschlich als contact_conflict abgelehnt.
  perform pg_advisory_xact_lock(hashtextextended(v_tenant.id::text || ':' || p_external_contact_ref, 0));

  begin
    insert into review.contacts (tenant_id, external_ref, first_name, email_normalized,
                                 consent_basis, consent_source, consent_documented_at)
    values (v_tenant.id, p_external_contact_ref, nullif(btrim(p_first_name), ''), v_email,
            p_consent_basis, p_consent_source, p_consent_documented_at)
    on conflict (tenant_id, external_ref) do update
      set first_name = coalesce(excluded.first_name, review.contacts.first_name),
          email_normalized = excluded.email_normalized,
          consent_basis = coalesce(excluded.consent_basis, review.contacts.consent_basis),
          consent_source = coalesce(excluded.consent_source, review.contacts.consent_source),
          consent_documented_at = coalesce(excluded.consent_documented_at, review.contacts.consent_documented_at)
    returning id into v_contact_id;
  exception when unique_violation then
    return jsonb_build_object('result', 'rejected', 'reason', 'contact_conflict');
  end;

  -- Der Upsert oben serialisiert parallele Aufrufe für denselben Kontakt. Ein Aufruf, der hier
  -- nach einem schnelleren mit demselben Ereignis ankommt, muss "duplicate" bekommen.
  select e.id into v_event_id
    from review.completion_events e
   where e.tenant_id = v_tenant.id and e.source = v_int.source and e.external_event_id = p_external_event_id;
  if found then
    select c.id into v_campaign_id from review.campaigns c where c.tenant_id = v_tenant.id and c.event_id = v_event_id;
    return jsonb_build_object('result', 'duplicate', 'campaign_id', v_campaign_id);
  end if;

  -- V1-Regel: höchstens eine Kampagne pro Kontakt und Standort. Früh ablehnen, damit kein
  -- verwaistes Abschlussereignis ohne Kampagne zurückbleibt.
  if exists (select 1 from review.campaigns c
              where c.tenant_id = v_tenant.id and c.location_id = v_loc.id and c.contact_id = v_contact_id) then
    return jsonb_build_object('result', 'rejected', 'reason', 'campaign_exists');
  end if;

  insert into review.completion_events (tenant_id, location_id, contact_id, source, external_event_id, completed_at)
  values (v_tenant.id, v_loc.id, v_contact_id, v_int.source, p_external_event_id, p_completed_at)
  on conflict (tenant_id, source, external_event_id) do nothing
  returning id into v_event_id;

  if v_event_id is null then
    -- Paralleler Aufruf mit demselben Ereignis war schneller.
    select e.id into v_event_id
      from review.completion_events e
     where e.tenant_id = v_tenant.id and e.source = v_int.source and e.external_event_id = p_external_event_id;
    select c.id into v_campaign_id from review.campaigns c where c.tenant_id = v_tenant.id and c.event_id = v_event_id;
    return jsonb_build_object('result', 'duplicate', 'campaign_id', v_campaign_id);
  end if;

  insert into review.campaigns (tenant_id, location_id, contact_id, event_id)
  values (v_tenant.id, v_loc.id, v_contact_id, v_event_id)
  on conflict (tenant_id, location_id, contact_id) do nothing
  returning id into v_campaign_id;

  if v_campaign_id is null then
    return jsonb_build_object('result', 'rejected', 'reason', 'campaign_exists');
  end if;

  v_due := greatest(v_now, p_completed_at + make_interval(mins => v_set.initial_delay_minutes));
  insert into review.send_jobs (tenant_id, campaign_id, kind, business_key, idempotency_key, due_at)
  values (v_tenant.id, v_campaign_id, 'initial',
          v_campaign_id::text || ':initial', 'rv-' || v_campaign_id::text || '-initial', v_due)
  returning id into v_job_id;

  return jsonb_build_object('result', 'created', 'campaign_id', v_campaign_id,
                            'job_id', v_job_id, 'first_send_due_at', v_due);
end
$$;

-- ---------------------------------------------------------------------------
-- Workflow B: fällige Sendungen atomar reservieren
-- ---------------------------------------------------------------------------
-- Jede Prüfung (Pause, Sperre, Fenster, Limit, Testmodus) läuft hier direkt vor der Reservierung.
-- Jobs, die nicht senden dürfen, werden zurückgestellt oder gestoppt und nicht zurückgegeben.

create function public.rv_claim_due_jobs(
  p_worker text,
  p_limit int default 5,
  p_lease_seconds int default 300
) returns table (
  job_id uuid, tenant_id uuid, campaign_id uuid, kind text, idempotency_key text, attempt int,
  to_email text, first_name text, sender_name text, sender_email text, reply_to_email text,
  template_version text, click_token text, unsub_token text, studio_name text
)
language plpgsql security definer set search_path = ''
as $$
#variable_conflict use_column
declare
  r record;
  v_now timestamptz := now();
  v_count int := 0;
  v_slot timestamptz;
  v_day_start timestamptz;
  v_used int;
  v_click text;
  v_unsub text;
begin
  if p_worker is null or char_length(p_worker) not between 1 and 100 then
    raise exception 'invalid worker';
  end if;
  p_limit := least(greatest(coalesce(p_limit, 5), 1), 20);
  p_lease_seconds := least(greatest(coalesce(p_lease_seconds, 300), 60), 900);

  -- Abgelaufene Leases: nie gesendet -> zurück in die Queue. Ab 'sending' -> Ausgang unklar.
  update review.send_jobs
     set status = 'queued', claimed_by = null, lease_expires_at = null, updated_at = v_now
   where status = 'claimed' and lease_expires_at < v_now;
  update review.send_jobs
     set status = 'unknown', last_error_class = 'unknown_outcome', last_error_at = v_now, updated_at = v_now
   where status = 'sending' and lease_expires_at < v_now;

  if (select s.send_paused from review.system_settings s where s.id) then
    return;
  end if;

  for r in
    select j.id as jid, j.tenant_id as tid, j.campaign_id as cid, j.kind as jkind, j.due_at,
           j.idempotency_key as idem, j.attempts,
           t.status as t_status, t.timezone as tz, l.status as l_status, l.name as l_name,
           c.status as c_status,
           k.email_normalized as email, k.first_name as fname, k.consent_basis,
           s.sender_name as s_name, s.sender_email as s_email, s.reply_to_email as s_reply,
           s.template_version as s_tpl, s.test_mode, s.test_recipients,
           s.send_window_start, s.send_window_end, s.send_weekdays,
           s.max_sends_per_day, s.stale_after_hours
      from review.send_jobs j
      join review.campaigns c on c.tenant_id = j.tenant_id and c.id = j.campaign_id
      join review.contacts k on k.tenant_id = c.tenant_id and k.id = c.contact_id
      join review.tenants t on t.id = j.tenant_id
      join review.locations l on l.tenant_id = c.tenant_id and l.id = c.location_id
      join review.tenant_settings s on s.tenant_id = j.tenant_id
     where j.status = 'queued' and j.due_at <= v_now
     order by j.due_at, j.id
     limit p_limit * 4
       for update of j skip locked
  loop
    exit when v_count >= p_limit;

    -- Pausierte Mandanten und Standorte: Job bleibt unverändert in der Queue.
    if r.t_status <> 'active' or r.l_status <> 'active' then
      continue;
    end if;

    if r.c_status <> 'active' then
      update review.send_jobs set status = 'cancelled', updated_at = v_now where id = r.jid;
      continue;
    end if;

    if r.consent_basis is null then
      perform review.stop_campaign(r.tid, r.cid, 'no_consent');
      continue;
    end if;

    if exists (select 1 from review.suppressions x
                where x.tenant_id = r.tid and x.email_hash = review.email_hash(r.email)) then
      perform review.stop_campaign(r.tid, r.cid, 'suppressed');
      continue;
    end if;

    -- Zu spät gewordene Anfragen nicht nachholen (z. B. nach längerer Störung).
    if v_now - r.due_at > make_interval(hours => r.stale_after_hours) then
      perform review.stop_campaign(r.tid, r.cid, 'expired');
      continue;
    end if;

    -- Versandfenster in der Mandantenzeitzone: außerhalb wird die Fälligkeit verschoben.
    v_slot := review.next_send_slot(v_now, r.tz, r.send_window_start, r.send_window_end, r.send_weekdays);
    if v_slot is null then
      continue;
    end if;
    if v_slot > v_now then
      update review.send_jobs set due_at = v_slot, updated_at = v_now where id = r.jid;
      continue;
    end if;

    -- Tageslimit pro Mandant: verhindert Massenversand nach Störungen.
    v_day_start := date_trunc('day', v_now at time zone r.tz) at time zone r.tz;
    select count(*)::int into v_used
      from review.send_jobs x
     where x.tenant_id = r.tid and x.claimed_at >= v_day_start
       and x.status in ('claimed', 'sending', 'sent', 'unknown');
    if v_used >= r.max_sends_per_day then
      continue;
    end if;

    -- Testmodus: nur freigegebene Testadressen erhalten E-Mails, sonst Dry Run.
    if r.test_mode and not exists (select 1 from unnest(r.test_recipients) tr
                                    where lower(btrim(tr)) = r.email) then
      update review.send_jobs set status = 'dry_run', updated_at = v_now where id = r.jid;
      perform review.stop_campaign(r.tid, r.cid, 'dry_run');
      continue;
    end if;

    update review.send_jobs
       set status = 'claimed', claimed_by = p_worker, claimed_at = v_now,
           lease_expires_at = v_now + make_interval(secs => p_lease_seconds),
           attempts = attempts + 1, updated_at = v_now
     where id = r.jid;

    v_click := review.new_token();
    v_unsub := review.new_token();
    insert into review.link_tokens (token_hash, tenant_id, campaign_id, job_id, purpose, expires_at)
    values (review.token_hash(v_click), r.tid, r.cid, r.jid, 'click', v_now + interval '90 days'),
           (review.token_hash(v_unsub), r.tid, r.cid, r.jid, 'unsub', v_now + interval '730 days');

    job_id := r.jid; tenant_id := r.tid; campaign_id := r.cid; kind := r.jkind;
    idempotency_key := r.idem; attempt := r.attempts + 1;
    to_email := r.email; first_name := r.fname;
    sender_name := r.s_name; sender_email := r.s_email; reply_to_email := r.s_reply;
    template_version := r.s_tpl; click_token := v_click; unsub_token := v_unsub; studio_name := r.l_name;
    v_count := v_count + 1;
    return next;
  end loop;
end
$$;

-- Direkt vor dem Provider-Aufruf: letzte Prüfung, dann Status 'sending'.
create function public.rv_mark_job_sending(p_job_id uuid, p_worker text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  j review.send_jobs%rowtype;
  v_now timestamptz := now();
  v_t_status text;
  v_l_status text;
  v_c_status text;
  v_email text;
begin
  select * into j from review.send_jobs where id = p_job_id for update;
  if not found or j.status <> 'claimed' or j.claimed_by is distinct from p_worker or j.lease_expires_at < v_now then
    return jsonb_build_object('ok', false, 'reason', 'not_claimed');
  end if;

  select t.status, l.status, c.status, k.email_normalized
    into v_t_status, v_l_status, v_c_status, v_email
    from review.campaigns c
    join review.contacts k on k.tenant_id = c.tenant_id and k.id = c.contact_id
    join review.tenants t on t.id = c.tenant_id
    join review.locations l on l.tenant_id = c.tenant_id and l.id = c.location_id
   where c.tenant_id = j.tenant_id and c.id = j.campaign_id;

  if v_c_status <> 'active' then
    update review.send_jobs set status = 'cancelled', claimed_by = null, lease_expires_at = null, updated_at = v_now
     where id = j.id;
    return jsonb_build_object('ok', false, 'reason', 'campaign_stopped');
  end if;
  if exists (select 1 from review.suppressions x
              where x.tenant_id = j.tenant_id and x.email_hash = review.email_hash(v_email)) then
    perform review.stop_campaign(j.tenant_id, j.campaign_id, 'suppressed');
    return jsonb_build_object('ok', false, 'reason', 'suppressed');
  end if;
  if v_t_status <> 'active' or v_l_status <> 'active'
     or (select s.send_paused from review.system_settings s where s.id) then
    update review.send_jobs set status = 'queued', claimed_by = null, lease_expires_at = null, updated_at = v_now
     where id = j.id;
    return jsonb_build_object('ok', false, 'reason', 'paused');
  end if;

  update review.send_jobs
     set status = 'sending', lease_expires_at = v_now + interval '10 minutes', updated_at = v_now
   where id = j.id;
  return jsonb_build_object('ok', true);
end
$$;

-- Ergebnis des Provider-Aufrufs melden.
--   sent              Provider hat angenommen (provider_message_id übergeben)
--   transient_error   z. B. 429/5xx, es kommt ein Retry mit Backoff
--   permanent_error   z. B. 4xx-Validierungsfehler, Kampagne wird gestoppt
--   unknown_outcome   Timeout o. ä., Ausgang unklar: zur Abstimmung markieren
--   config_error      Provider lehnt Zugang ab (401/403, Domain nicht verifiziert). Der Job geht
--                     ohne verbrauchten Versuch zurück in die Queue und der Versand wird global
--                     pausiert, damit eine Fehlkonfiguration nicht alle Kampagnen verbrennt.
create function public.rv_complete_job(
  p_job_id uuid,
  p_worker text,
  p_outcome text,
  p_provider_message_id text default null
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  j review.send_jobs%rowtype;
  v_now timestamptz := now();
  v_delay_hours int;
begin
  if p_outcome not in ('sent', 'transient_error', 'permanent_error', 'unknown_outcome', 'config_error') then
    raise exception 'invalid outcome';
  end if;
  if p_outcome = 'sent' and (p_provider_message_id is null or char_length(p_provider_message_id) > 128) then
    raise exception 'provider_message_id required';
  end if;

  select * into j from review.send_jobs where id = p_job_id for update;
  if not found or j.claimed_by is distinct from p_worker or j.status not in ('claimed', 'sending', 'unknown') then
    return jsonb_build_object('ok', false, 'reason', 'not_owner_or_state');
  end if;

  if p_outcome = 'sent' then
    update review.send_jobs
       set status = 'sent', sent_at = v_now, provider_message_id = p_provider_message_id,
           lease_expires_at = null, updated_at = v_now
     where id = j.id;
    if j.kind = 'initial' then
      select s.reminder_delay_hours into v_delay_hours from review.tenant_settings s where s.tenant_id = j.tenant_id;
      -- Höchstens eine Erinnerung, nur wenn die Kampagne noch aktiv ist.
      insert into review.send_jobs (tenant_id, campaign_id, kind, business_key, idempotency_key, due_at)
      select j.tenant_id, j.campaign_id, 'reminder',
             j.campaign_id::text || ':reminder', 'rv-' || j.campaign_id::text || '-reminder',
             v_now + make_interval(hours => v_delay_hours)
        from review.campaigns c
       where c.tenant_id = j.tenant_id and c.id = j.campaign_id and c.status = 'active'
      on conflict (tenant_id, business_key) do nothing;
    else
      update review.campaigns set status = 'completed', end_reason = 'reminder_sent'
       where tenant_id = j.tenant_id and id = j.campaign_id and status = 'active';
    end if;
    return jsonb_build_object('ok', true, 'status', 'sent');
  end if;

  if p_outcome = 'config_error' then
    update review.send_jobs
       set status = 'queued', claimed_by = null, lease_expires_at = null,
           attempts = greatest(attempts - 1, 0), last_error_class = 'transient', last_error_at = v_now,
           updated_at = v_now
     where id = j.id;
    update review.system_settings
       set send_paused = true, pause_reason = 'provider_config_error', updated_at = v_now
     where id;
    return jsonb_build_object('ok', true, 'status', 'queued', 'paused', true);
  end if;

  if p_outcome = 'unknown_outcome' then
    update review.send_jobs
       set status = 'unknown', last_error_class = 'unknown_outcome', last_error_at = v_now, updated_at = v_now
     where id = j.id;
    return jsonb_build_object('ok', true, 'status', 'unknown');
  end if;

  if p_outcome = 'transient_error' and j.attempts < j.max_attempts then
    update review.send_jobs
       set status = 'queued', claimed_by = null, lease_expires_at = null,
           last_error_class = 'transient', last_error_at = v_now,
           due_at = v_now + least(power(2, j.attempts)::int * interval '5 minutes', interval '6 hours'),
           updated_at = v_now
     where id = j.id;
    return jsonb_build_object('ok', true, 'status', 'queued');
  end if;

  update review.send_jobs
     set status = 'failed', lease_expires_at = null,
         last_error_class = case when p_outcome = 'permanent_error' then 'permanent' else 'transient' end,
         last_error_at = v_now, updated_at = v_now
   where id = j.id;
  perform review.stop_campaign(j.tenant_id, j.campaign_id, 'send_failed');
  return jsonb_build_object('ok', true, 'status', 'failed');
end
$$;

-- Abstimmung eines Jobs im Status 'unknown' (manuell oder durch Workflow F nach Provider-Abgleich).
create function public.rv_resolve_unknown_job(
  p_job_id uuid,
  p_resolution text,
  p_provider_message_id text default null
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  j review.send_jobs%rowtype;
  v_now timestamptz := now();
  v_delay_hours int;
begin
  if p_resolution not in ('sent', 'not_sent') then
    raise exception 'invalid resolution';
  end if;
  select * into j from review.send_jobs where id = p_job_id for update;
  if not found or j.status <> 'unknown' then
    return jsonb_build_object('ok', false, 'reason', 'not_unknown');
  end if;

  if p_resolution = 'sent' then
    update review.send_jobs
       set status = 'sent', sent_at = coalesce(sent_at, v_now), provider_message_id = p_provider_message_id,
           updated_at = v_now
     where id = j.id;
    if j.kind = 'initial' then
      select s.reminder_delay_hours into v_delay_hours from review.tenant_settings s where s.tenant_id = j.tenant_id;
      insert into review.send_jobs (tenant_id, campaign_id, kind, business_key, idempotency_key, due_at)
      select j.tenant_id, j.campaign_id, 'reminder',
             j.campaign_id::text || ':reminder', 'rv-' || j.campaign_id::text || '-reminder',
             v_now + make_interval(hours => v_delay_hours)
        from review.campaigns c
       where c.tenant_id = j.tenant_id and c.id = j.campaign_id and c.status = 'active'
      on conflict (tenant_id, business_key) do nothing;
    end if;
  else
    -- Nachweislich nicht gesendet: sofort wieder fällig, gleicher Idempotenzschlüssel.
    update review.send_jobs
       set status = 'queued', claimed_by = null, lease_expires_at = null, due_at = v_now, updated_at = v_now
     where id = j.id;
  end if;
  return jsonb_build_object('ok', true);
end
$$;

-- ---------------------------------------------------------------------------
-- Workflow C: Provider-Ereignisse (Signaturprüfung erfolgt vorher am Rohbody)
-- ---------------------------------------------------------------------------
-- result = applied | duplicate | unmatched | ignored
-- unmatched: Job mit dieser Provider-ID ist (noch) unbekannt. Der Aufrufer antwortet dem Provider
-- mit einem Fehlerstatus, damit das Ereignis später erneut zugestellt wird.

create function public.rv_apply_provider_event(
  p_provider text,
  p_event_id text,
  p_event_type text,
  p_occurred_at timestamptz,
  p_provider_message_id text
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  j review.send_jobs%rowtype;
  v_email text;
  v_new_state text;
  v_inserted uuid;
  v_rank_old int;
  v_rank_new int;
  rank_of constant jsonb := '{"unknown":0,"delayed":1,"delivered":2,"bounced":3,"complained":4}'::jsonb;
begin
  if p_event_type not in ('delivered', 'delayed', 'bounced_hard', 'bounced_soft', 'complained') then
    return jsonb_build_object('result', 'ignored');
  end if;
  if p_event_id is null or char_length(p_event_id) not between 1 and 128
     or p_provider_message_id is null or p_occurred_at is null then
    raise exception 'invalid event';
  end if;

  select * into j from review.send_jobs
   where provider = p_provider and provider_message_id = p_provider_message_id
   for update;
  if not found then
    return jsonb_build_object('result', 'unmatched');
  end if;

  insert into review.provider_events (provider, provider_event_id, tenant_id, job_id, event_type, occurred_at)
  values (p_provider, p_event_id, j.tenant_id, j.id, p_event_type, p_occurred_at)
  on conflict (provider, provider_event_id) do nothing
  returning id into v_inserted;
  if v_inserted is null then
    return jsonb_build_object('result', 'duplicate');
  end if;

  -- Zustand nur "aufwärts" ändern: ein verspätetes 'delivered' überschreibt kein 'bounced'.
  v_new_state := case p_event_type
    when 'delivered' then 'delivered'
    when 'delayed' then 'delayed'
    when 'bounced_hard' then 'bounced'
    when 'complained' then 'complained'
    else null end;
  if v_new_state is not null then
    v_rank_old := (rank_of ->> j.delivery_state)::int;
    v_rank_new := (rank_of ->> v_new_state)::int;
    if v_rank_new > v_rank_old then
      update review.send_jobs set delivery_state = v_new_state, updated_at = now() where id = j.id;
    end if;
  end if;

  -- Hard Bounce und Beschwerde sperren die Adresse sofort und stoppen die Erinnerung.
  if p_event_type in ('bounced_hard', 'complained') then
    select k.email_normalized into v_email
      from review.campaigns c
      join review.contacts k on k.tenant_id = c.tenant_id and k.id = c.contact_id
     where c.tenant_id = j.tenant_id and c.id = j.campaign_id;
    if v_email is not null then
      perform review.suppress_email(j.tenant_id, v_email,
        case when p_event_type = 'complained' then 'complaint' else 'hard_bounce' end);
    end if;
  end if;

  return jsonb_build_object('result', 'applied');
end
$$;

-- ---------------------------------------------------------------------------
-- Klick und Abmeldung
-- ---------------------------------------------------------------------------
-- raw:       reiner HTTP-Aufruf (kann ein E-Mail-Scanner sein), stoppt nichts, liefert keine URL
-- qualified: bewusster Klick auf den Button der Zwischenseite, stoppt die Erinnerung, liefert die URL
-- Ungültige oder abgelaufene Tokens liefern nur {"valid": false}, ohne jede Kontaktangabe.

create function public.rv_register_click(p_token text, p_class text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  tok review.link_tokens%rowtype;
  v_url text;
  v_studio text;
begin
  if p_class not in ('raw', 'qualified') then
    raise exception 'invalid class';
  end if;
  if p_token is null or char_length(p_token) not between 20 and 200 then
    return jsonb_build_object('valid', false);
  end if;

  select * into tok from review.link_tokens
   where token_hash = review.token_hash(p_token) and purpose = 'click' and expires_at > now();
  if not found then
    return jsonb_build_object('valid', false);
  end if;

  select l.google_review_url, l.name into v_url, v_studio
    from review.campaigns c
    join review.locations l on l.tenant_id = c.tenant_id and l.id = c.location_id
   where c.tenant_id = tok.tenant_id and c.id = tok.campaign_id;

  insert into review.click_events (tenant_id, campaign_id, click_class)
  values (tok.tenant_id, tok.campaign_id, p_class);

  if p_class = 'raw' then
    return jsonb_build_object('valid', true, 'studio', v_studio);
  end if;

  update review.campaigns set status = 'completed', end_reason = 'qualified_click'
   where tenant_id = tok.tenant_id and id = tok.campaign_id and status = 'active';
  update review.send_jobs set status = 'cancelled', claimed_by = null, lease_expires_at = null, updated_at = now()
   where tenant_id = tok.tenant_id and campaign_id = tok.campaign_id
     and kind = 'reminder' and status in ('queued', 'claimed');
  return jsonb_build_object('valid', true, 'studio', v_studio, 'url', v_url);
end
$$;

-- GET der Abmeldeseite: nur prüfen, nichts ändern (Scanner dürfen nicht versehentlich abmelden).
create function public.rv_unsubscribe_check(p_token text)
returns boolean
language sql security definer stable set search_path = ''
as $$
  select exists (
    select 1 from review.link_tokens t
     where t.token_hash = review.token_hash(p_token) and t.purpose = 'unsub' and t.expires_at > now()
  );
$$;

-- Bewusste Aktion (POST): Sperre setzen und offene Sendungen stoppen.
create function public.rv_unsubscribe(p_token text)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  v_tenant uuid;
  v_email text;
begin
  if p_token is null or char_length(p_token) not between 20 and 200 then
    return false;
  end if;
  select t.tenant_id, k.email_normalized into v_tenant, v_email
    from review.link_tokens t
    join review.campaigns c on c.tenant_id = t.tenant_id and c.id = t.campaign_id
    join review.contacts k on k.tenant_id = c.tenant_id and k.id = c.contact_id
   where t.token_hash = review.token_hash(p_token) and t.purpose = 'unsub' and t.expires_at > now();
  if not found then
    return false;
  end if;
  perform review.suppress_email(v_tenant, v_email, 'unsubscribe');
  return true;
end
$$;

-- ---------------------------------------------------------------------------
-- Rechte: nur service_role darf die RPCs ausführen
-- ---------------------------------------------------------------------------

do $$
declare
  f record;
  r text;
begin
  for f in
    select p.oid::regprocedure as sig
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
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

-- Interne Funktionen im Schema review sind nie über PUBLIC erreichbar.
revoke all on all functions in schema review from public;
