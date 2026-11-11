-- PILEOT Google Review Automation, V1: Kundenschablone
--
-- Alles Kundenspezifische liegt in der Datenbank und ist über das Admin-Formular (rv-admin)
-- pflegbar: Namen, Adressen, Links, Empfängerin, Versandregeln, Texte und Gestaltung der Mails.
-- Neue Kundin = ein Formular, kein Code, keine neue Migration.
--
-- Texte unterstützen genau zwei Platzhalter: {{studio}} (Standortname) und {{vorname}} (nur in der
-- Anrede mit Vorname). Alles andere wird abgelehnt. Gerendert wird immer mit HTML-Escaping.

-- ---------------------------------------------------------------------------
-- Hilfsfunktionen
-- ---------------------------------------------------------------------------

-- Gültiger Freitext: keine Steuerzeichen (außer Zeilenumbruch und Tab), nur bekannte Platzhalter.
create function review.valid_text(p text, p_allow_vorname boolean) returns boolean
language sql immutable set search_path = ''
as $$
  select p !~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]'
     and not exists (
       select 1
         from regexp_matches(p, '\{\{([^{}]*)\}\}', 'g') m
        where btrim(m[1]) <> all (
          case when p_allow_vorname then array['studio', 'vorname'] else array['studio'] end)
     )
$$;

-- Einzeilig (Betreff, Anrede, Button): zusätzlich kein Zeilenumbruch.
create function review.valid_line(p text, p_allow_vorname boolean) returns boolean
language sql immutable set search_path = ''
as $$ select review.valid_text(p, p_allow_vorname) and p !~ '[\r\n]' $$;

-- Zeilenenden vereinheitlichen, Anfang und Ende von Leerraum befreien.
create function review.norm(p text) returns text
language sql immutable set search_path = ''
as $$ select regexp_replace(replace(replace(p, E'\r\n', E'\n'), E'\r', E'\n'), '^\s+|\s+$', '', 'g') $$;

-- Einzige Quelle der Standardwerte für das Formular und neue Kundinnen (flach, gleiche Schlüssel
-- wie review.tenant_config). Ein Test stellt sicher, dass die Spaltenstandards identisch sind.
create function review.defaults() returns jsonb
language sql immutable set search_path = ''
as $$
  select jsonb_build_object(
    'timezone', 'Europe/Berlin',
    'report_enabled', true,
    'send_window_start', '09:00',
    'send_window_end', '18:00',
    'send_weekdays', jsonb_build_array(1, 2, 3, 4, 5),
    'initial_delay_minutes', 120,
    'reminder_delay_hours', 48,
    'max_sends_per_day', 20,
    'stale_after_hours', 72,
    'retention_days', 365,
    'test_recipients', '[]'::jsonb,
    'greeting_named', 'Hallo {{vorname}},',
    'greeting_anonymous', 'Hallo,',
    'signature', E'Herzliche Grüße\n{{studio}}',
    'footer_text', 'Sie erhalten diese Nachricht im Zusammenhang mit Ihrem Termin bei {{studio}}.',
    'unsubscribe_label', 'Keine weiteren E-Mails dieser Art erhalten',
    'imprint_text', '',
    'accent_color', '#1f2937',
    'initial_subject', 'Wie war Ihr Termin bei {{studio}}?',
    'initial_body', E'vielen Dank für Ihren Besuch bei {{studio}}.\n\nWenn Sie einen Moment Zeit haben, freuen wir uns über Ihre ehrliche Bewertung bei Google. Sie hilft anderen bei der Entscheidung und uns, besser zu werden.',
    'initial_button', 'Bewertung bei Google schreiben',
    'initial_closing', '',
    'reminder_subject', 'Kurze Erinnerung: Ihre Meinung zu {{studio}}',
    'reminder_body', 'vor ein paar Tagen waren Sie bei {{studio}}. Falls Sie es noch nicht geschafft haben: Wir freuen uns weiterhin über Ihre ehrliche Bewertung bei Google.',
    'reminder_button', 'Bewertung bei Google schreiben',
    'reminder_closing', 'Das ist unsere letzte Nachricht dazu.'
  )
$$;

-- ---------------------------------------------------------------------------
-- Spalten und Tabelle
-- ---------------------------------------------------------------------------

alter table review.tenant_settings
  add column greeting_named text not null default 'Hallo {{vorname}},'
    check (char_length(greeting_named) between 1 and 120 and review.valid_line(greeting_named, true)),
  add column greeting_anonymous text not null default 'Hallo,'
    check (char_length(greeting_anonymous) between 1 and 120 and review.valid_line(greeting_anonymous, false)),
  add column signature text not null default E'Herzliche Grüße\n{{studio}}'
    check (char_length(signature) between 1 and 300 and review.valid_text(signature, false)),
  add column footer_text text not null
    default 'Sie erhalten diese Nachricht im Zusammenhang mit Ihrem Termin bei {{studio}}.'
    check (char_length(footer_text) between 1 and 300 and review.valid_text(footer_text, false)),
  add column unsubscribe_label text not null default 'Keine weiteren E-Mails dieser Art erhalten'
    check (char_length(unsubscribe_label) between 1 and 100 and review.valid_line(unsubscribe_label, false)),
  -- Anbieterkennzeichnung (Impressum) im Fuß der Mail. Pflicht vor dem Livegang.
  add column imprint_text text not null default ''
    check (char_length(imprint_text) <= 600 and review.valid_text(imprint_text, false)),
  add column accent_color text not null default '#1f2937' check (accent_color ~ '^#[0-9a-fA-F]{6}$'),
  add column report_enabled boolean not null default true;

create table review.message_templates (
  tenant_id uuid not null references review.tenants (id) on delete cascade,
  kind text not null check (kind in ('initial', 'reminder')),
  subject text not null check (char_length(subject) between 1 and 150 and review.valid_line(subject, false)),
  -- Text nach der Anrede. Leerzeile = neuer Absatz. Der Button mit dem Google-Link folgt danach.
  body text not null check (char_length(body) between 1 and 1500 and review.valid_text(body, false)),
  button_label text not null check (char_length(button_label) between 1 and 60 and review.valid_line(button_label, false)),
  -- Zeile unter dem Button (optional)
  closing_note text not null default '' check (char_length(closing_note) <= 300 and review.valid_text(closing_note, false)),
  primary key (tenant_id, kind)
);

alter table review.message_templates enable row level security;

create function review.ensure_templates(p_tenant_id uuid) returns void
language sql volatile set search_path = ''
as $$
  insert into review.message_templates (tenant_id, kind, subject, body, button_label, closing_note)
  select p_tenant_id, k,
         review.defaults() ->> (k || '_subject'), review.defaults() ->> (k || '_body'),
         review.defaults() ->> (k || '_button'), review.defaults() ->> (k || '_closing')
    from unnest(array['initial', 'reminder']) k
  on conflict (tenant_id, kind) do nothing
$$;

-- Bestehende Mandanten (falls vorhanden) bekommen die Standardtexte.
select review.ensure_templates(id) from review.tenants;

-- ---------------------------------------------------------------------------
-- Gesamte Konfiguration einer Kundin (flach). Einzige Leseform für Formular und Versand.
-- ---------------------------------------------------------------------------

create function review.tenant_config(p_tenant_id uuid) returns jsonb
language plpgsql stable set search_path = ''
as $$
declare
  d jsonb := review.defaults();
  r jsonb;
begin
  select jsonb_build_object(
    'name', t.name,
    'timezone', t.timezone,
    'location_name', l.name,
    'google_review_url', l.google_review_url,
    'sender_name', s.sender_name,
    'sender_email', s.sender_email,
    'reply_to_email', s.reply_to_email,
    'report_recipient_email', s.report_recipient_email,
    'report_enabled', s.report_enabled,
    'send_window_start', to_char(s.send_window_start, 'HH24:MI'),
    'send_window_end', to_char(s.send_window_end, 'HH24:MI'),
    'send_weekdays', to_jsonb(s.send_weekdays),
    'initial_delay_minutes', s.initial_delay_minutes,
    'reminder_delay_hours', s.reminder_delay_hours,
    'max_sends_per_day', s.max_sends_per_day,
    'stale_after_hours', s.stale_after_hours,
    'retention_days', s.retention_days,
    'test_recipients', to_jsonb(s.test_recipients),
    'greeting_named', s.greeting_named,
    'greeting_anonymous', s.greeting_anonymous,
    'signature', s.signature,
    'footer_text', s.footer_text,
    'unsubscribe_label', s.unsubscribe_label,
    'imprint_text', s.imprint_text,
    'accent_color', s.accent_color,
    'initial_subject', coalesce(ti.subject, d ->> 'initial_subject'),
    'initial_body', coalesce(ti.body, d ->> 'initial_body'),
    'initial_button', coalesce(ti.button_label, d ->> 'initial_button'),
    'initial_closing', coalesce(ti.closing_note, d ->> 'initial_closing'),
    'reminder_subject', coalesce(tr.subject, d ->> 'reminder_subject'),
    'reminder_body', coalesce(tr.body, d ->> 'reminder_body'),
    'reminder_button', coalesce(tr.button_label, d ->> 'reminder_button'),
    'reminder_closing', coalesce(tr.closing_note, d ->> 'reminder_closing')
  )
  into r
  from review.tenants t
  join review.tenant_settings s on s.tenant_id = t.id
  join lateral (
    select x.* from review.locations x where x.tenant_id = t.id order by x.created_at, x.id limit 1
  ) l on true
  left join review.message_templates ti on ti.tenant_id = t.id and ti.kind = 'initial'
  left join review.message_templates tr on tr.tenant_id = t.id and tr.kind = 'reminder'
  where t.id = p_tenant_id;
  return r;
end
$$;

-- Für den Versand (rv-jobs): Konfiguration einer Kundin.
create function public.rv_get_mail_config(p_tenant_id uuid) returns jsonb
language sql stable security definer set search_path = ''
as $$ select review.tenant_config(p_tenant_id) $$;

-- ---------------------------------------------------------------------------
-- Admin-RPCs (nur service_role, aufgerufen von rv-admin)
-- ---------------------------------------------------------------------------

create function public.rv_admin_defaults() returns jsonb
language sql stable security definer set search_path = ''
as $$ select review.defaults() $$;

create function public.rv_admin_list_tenants() returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'tenant_id', t.id,
    'name', t.name,
    'status', t.status,
    'test_mode', s.test_mode,
    'sender_email', s.sender_email,
    'created_at', t.created_at
  ) order by t.created_at), '[]'::jsonb)
  from review.tenants t
  join review.tenant_settings s on s.tenant_id = t.id
$$;

create function public.rv_admin_get_tenant(p_tenant_id uuid) returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'tenant_id', t.id,
    'location_id', (select x.id from review.locations x where x.tenant_id = t.id order by x.created_at, x.id limit 1),
    'status', t.status,
    'test_mode', s.test_mode,
    'global_paused', (select send_paused from review.system_settings),
    'sent_total', (select count(*) from review.send_jobs j where j.tenant_id = t.id and j.status = 'sent'),
    'config', review.tenant_config(t.id),
    'integrations', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', i.id, 'source', i.source, 'created_at', i.created_at, 'revoked_at', i.revoked_at
      ) order by i.created_at)
      from review.integrations i where i.tenant_id = t.id), '[]'::jsonb)
  )
  from review.tenants t
  join review.tenant_settings s on s.tenant_id = t.id
  where t.id = p_tenant_id
$$;

-- Anlegen (p_tenant_id null) oder Ändern. Es werden nur übergebene Felder geändert.
-- Neue Kundin: immer paused und Testmodus an. Freischalten nur über rv_admin_go_live.
-- Fehler: Exception mit Text "invalid_config: ..."
create function public.rv_admin_save_tenant(p_tenant_id uuid, p_config jsonb)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  c jsonb := coalesce(p_config, '{}'::jsonb);
  v_allowed text[] := array[
    'name', 'timezone', 'location_name', 'google_review_url',
    'sender_name', 'sender_email', 'reply_to_email', 'report_recipient_email', 'report_enabled',
    'send_window_start', 'send_window_end', 'send_weekdays', 'initial_delay_minutes',
    'reminder_delay_hours', 'max_sends_per_day', 'stale_after_hours', 'retention_days',
    'test_recipients', 'greeting_named', 'greeting_anonymous', 'signature', 'footer_text',
    'unsubscribe_label', 'imprint_text', 'accent_color',
    'initial_subject', 'initial_body', 'initial_button', 'initial_closing',
    'reminder_subject', 'reminder_body', 'reminder_button', 'reminder_closing'];
  v_required text[] := array[
    'name', 'location_name', 'google_review_url', 'sender_name', 'sender_email',
    'reply_to_email', 'report_recipient_email'];
  v_text_fields text[] := array[
    'name', 'timezone', 'location_name', 'google_review_url', 'sender_name', 'sender_email',
    'reply_to_email', 'report_recipient_email', 'send_window_start', 'send_window_end',
    'greeting_named', 'greeting_anonymous', 'signature', 'footer_text', 'unsubscribe_label',
    'imprint_text', 'accent_color', 'initial_subject', 'initial_body', 'initial_button',
    'initial_closing', 'reminder_subject', 'reminder_body', 'reminder_button', 'reminder_closing'];
  v_int_fields text[] := array[
    'initial_delay_minutes', 'reminder_delay_hours', 'max_sends_per_day', 'stale_after_hours', 'retention_days'];
  k text;
  v_tenant uuid := p_tenant_id;
  v_loc uuid;
  v_created boolean := false;
  v_email_re constant text := '^[^@\s]+@[^@\s]+\.[^@\s]+$';
begin
  if jsonb_typeof(c) <> 'object' then
    raise exception 'invalid_config: Objekt erwartet';
  end if;
  for k in select jsonb_object_keys(c) loop
    if k <> all (v_allowed) then
      raise exception 'invalid_config: unbekanntes Feld %', k;
    end if;
  end loop;
  foreach k in array v_text_fields loop
    if c ? k and jsonb_typeof(c -> k) <> 'string' then
      raise exception 'invalid_config: % muss Text sein', k;
    end if;
  end loop;
  foreach k in array v_int_fields loop
    if c ? k and (jsonb_typeof(c -> k) <> 'number' or (c ->> k) !~ '^[0-9]+$') then
      raise exception 'invalid_config: % muss eine ganze Zahl sein', k;
    end if;
  end loop;
  if c ? 'report_enabled' and jsonb_typeof(c -> 'report_enabled') <> 'boolean' then
    raise exception 'invalid_config: report_enabled muss true oder false sein';
  end if;
  if c ? 'send_weekdays' and (jsonb_typeof(c -> 'send_weekdays') <> 'array'
     or exists (select 1 from jsonb_array_elements(c -> 'send_weekdays') e
                 where jsonb_typeof(e) <> 'number' or (e #>> '{}') !~ '^[1-7]$')) then
    raise exception 'invalid_config: send_weekdays muss eine Liste aus 1 bis 7 sein';
  end if;
  if c ? 'test_recipients' then
    if jsonb_typeof(c -> 'test_recipients') <> 'array'
       or exists (select 1 from jsonb_array_elements(c -> 'test_recipients') e where jsonb_typeof(e) <> 'string') then
      raise exception 'invalid_config: test_recipients muss eine Liste von E-Mail-Adressen sein';
    end if;
    if exists (select 1 from jsonb_array_elements_text(c -> 'test_recipients') e
                where btrim(e) <> '' and lower(btrim(e)) !~ v_email_re) then
      raise exception 'invalid_config: test_recipients enthält eine ungültige E-Mail-Adresse';
    end if;
  end if;

  begin
    if v_tenant is null then
      foreach k in array v_required loop
        if not (c ? k) or btrim(c ->> k) = '' then
          raise exception 'invalid_config: Pflichtfeld % fehlt', k;
        end if;
      end loop;
      insert into review.tenants (name, timezone)
      values (review.norm(c ->> 'name'), coalesce(c ->> 'timezone', 'Europe/Berlin'))
      returning id into v_tenant;
      insert into review.locations (tenant_id, name, google_review_url)
      values (v_tenant, review.norm(c ->> 'location_name'), btrim(c ->> 'google_review_url'));
      insert into review.tenant_settings (tenant_id, sender_name, sender_email, reply_to_email, report_recipient_email)
      values (v_tenant, review.norm(c ->> 'sender_name'), lower(btrim(c ->> 'sender_email')),
              lower(btrim(c ->> 'reply_to_email')), lower(btrim(c ->> 'report_recipient_email')));
      perform review.ensure_templates(v_tenant);
      v_created := true;
    elsif not exists (select 1 from review.tenants where id = v_tenant) then
      raise exception 'invalid_config: Kundin nicht gefunden';
    end if;

    select x.id into v_loc from review.locations x where x.tenant_id = v_tenant order by x.created_at, x.id limit 1;

    update review.tenants set
      name = case when c ? 'name' then review.norm(c ->> 'name') else name end,
      timezone = case when c ? 'timezone' then btrim(c ->> 'timezone') else timezone end
    where id = v_tenant;

    update review.locations set
      name = case when c ? 'location_name' then review.norm(c ->> 'location_name') else name end,
      google_review_url = case when c ? 'google_review_url' then btrim(c ->> 'google_review_url') else google_review_url end
    where id = v_loc;

    update review.tenant_settings set
      sender_name = case when c ? 'sender_name' then review.norm(c ->> 'sender_name') else sender_name end,
      sender_email = case when c ? 'sender_email' then lower(btrim(c ->> 'sender_email')) else sender_email end,
      reply_to_email = case when c ? 'reply_to_email' then lower(btrim(c ->> 'reply_to_email')) else reply_to_email end,
      report_recipient_email = case when c ? 'report_recipient_email'
        then lower(btrim(c ->> 'report_recipient_email')) else report_recipient_email end,
      report_enabled = case when c ? 'report_enabled' then (c ->> 'report_enabled')::boolean else report_enabled end,
      send_window_start = case when c ? 'send_window_start' then (c ->> 'send_window_start')::time else send_window_start end,
      send_window_end = case when c ? 'send_window_end' then (c ->> 'send_window_end')::time else send_window_end end,
      send_weekdays = case when c ? 'send_weekdays'
        then (select array_agg(distinct (e)::smallint order by (e)::smallint) from jsonb_array_elements_text(c -> 'send_weekdays') e)
        else send_weekdays end,
      initial_delay_minutes = case when c ? 'initial_delay_minutes' then (c ->> 'initial_delay_minutes')::int else initial_delay_minutes end,
      reminder_delay_hours = case when c ? 'reminder_delay_hours' then (c ->> 'reminder_delay_hours')::int else reminder_delay_hours end,
      max_sends_per_day = case when c ? 'max_sends_per_day' then (c ->> 'max_sends_per_day')::int else max_sends_per_day end,
      stale_after_hours = case when c ? 'stale_after_hours' then (c ->> 'stale_after_hours')::int else stale_after_hours end,
      retention_days = case when c ? 'retention_days' then (c ->> 'retention_days')::int else retention_days end,
      test_recipients = case when c ? 'test_recipients'
        then coalesce((select array_agg(distinct lower(btrim(e))) from jsonb_array_elements_text(c -> 'test_recipients') e
                        where btrim(e) <> ''), '{}')
        else test_recipients end,
      greeting_named = case when c ? 'greeting_named' then review.norm(c ->> 'greeting_named') else greeting_named end,
      greeting_anonymous = case when c ? 'greeting_anonymous' then review.norm(c ->> 'greeting_anonymous') else greeting_anonymous end,
      signature = case when c ? 'signature' then review.norm(c ->> 'signature') else signature end,
      footer_text = case when c ? 'footer_text' then review.norm(c ->> 'footer_text') else footer_text end,
      unsubscribe_label = case when c ? 'unsubscribe_label' then review.norm(c ->> 'unsubscribe_label') else unsubscribe_label end,
      imprint_text = case when c ? 'imprint_text' then review.norm(c ->> 'imprint_text') else imprint_text end,
      accent_color = case when c ? 'accent_color' then lower(btrim(c ->> 'accent_color')) else accent_color end
    where tenant_id = v_tenant;

    update review.message_templates set
      subject = case when c ? 'initial_subject' then review.norm(c ->> 'initial_subject') else subject end,
      body = case when c ? 'initial_body' then review.norm(c ->> 'initial_body') else body end,
      button_label = case when c ? 'initial_button' then review.norm(c ->> 'initial_button') else button_label end,
      closing_note = case when c ? 'initial_closing' then review.norm(c ->> 'initial_closing') else closing_note end
    where tenant_id = v_tenant and kind = 'initial';

    update review.message_templates set
      subject = case when c ? 'reminder_subject' then review.norm(c ->> 'reminder_subject') else subject end,
      body = case when c ? 'reminder_body' then review.norm(c ->> 'reminder_body') else body end,
      button_label = case when c ? 'reminder_button' then review.norm(c ->> 'reminder_button') else button_label end,
      closing_note = case when c ? 'reminder_closing' then review.norm(c ->> 'reminder_closing') else closing_note end
    where tenant_id = v_tenant and kind = 'reminder';
  exception
    when others then
      if sqlerrm like 'invalid_config:%' then
        raise;
      end if;
      raise exception 'invalid_config: %', sqlerrm;
  end;

  select x.id into v_loc from review.locations x where x.tenant_id = v_tenant order by x.created_at, x.id limit 1;
  return jsonb_build_object('tenant_id', v_tenant, 'location_id', v_loc, 'created', v_created);
end
$$;

-- Livegang: Testmodus aus und Mandant aktiv. Nur mit bestätigtem Namen, hinterlegtem Impressum
-- und mindestens einer im Testmodus tatsächlich versendeten Mail.
create function public.rv_admin_go_live(p_tenant_id uuid, p_confirm_name text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_name text;
  v_missing text[] := '{}';
  v_global boolean;
begin
  select t.name into v_name from review.tenants t where t.id = p_tenant_id;
  if v_name is null then
    return jsonb_build_object('ok', false, 'missing', jsonb_build_array('tenant_not_found'));
  end if;
  if lower(btrim(coalesce(p_confirm_name, ''))) <> lower(btrim(v_name)) then
    v_missing := array_append(v_missing, 'confirm_name_mismatch');
  end if;
  if exists (select 1 from review.tenant_settings s where s.tenant_id = p_tenant_id and btrim(s.imprint_text) = '') then
    v_missing := array_append(v_missing, 'imprint_missing');
  end if;
  if not exists (select 1 from review.send_jobs j where j.tenant_id = p_tenant_id and j.status = 'sent') then
    v_missing := array_append(v_missing, 'no_test_send');
  end if;
  if cardinality(v_missing) > 0 then
    return jsonb_build_object('ok', false, 'missing', to_jsonb(v_missing));
  end if;
  update review.tenant_settings set test_mode = false where tenant_id = p_tenant_id;
  update review.tenants set status = 'active' where id = p_tenant_id;
  select send_paused into v_global from review.system_settings;
  return jsonb_build_object('ok', true, 'global_paused', v_global);
end
$$;

create function public.rv_admin_revoke_integration(p_tenant_id uuid, p_integration_id uuid)
returns boolean
language plpgsql security definer set search_path = ''
as $$
begin
  update review.integrations set revoked_at = now()
   where id = p_integration_id and tenant_id = p_tenant_id and revoked_at is null;
  return found;
end
$$;

-- rv_setup_tenant (Kurzform aus dem Runbook) legt jetzt auch die Standardtexte an.
create or replace function public.rv_setup_tenant(
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
  perform review.ensure_templates(v_tenant);
  return jsonb_build_object('tenant_id', v_tenant, 'location_id', v_location,
                            'status', 'paused', 'test_mode', true);
end
$$;

-- Wochenbericht nur für Kundinnen mit aktiviertem Bericht.
create or replace function public.rv_claim_weekly_reports(p_now timestamptz default now())
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
     where t.status = 'active' and s.report_enabled
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

-- ---------------------------------------------------------------------------
-- Rechte (wie in den vorigen Migrationen)
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
