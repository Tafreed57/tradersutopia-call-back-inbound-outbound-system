create or replace function public.callback_record_inbound(
  p_call_sid text, p_phone text, p_called_number text, p_started_at timestamptz,
  p_ended_at timestamptz default null, p_answered_at timestamptz default null
) returns void language plpgsql security invoker set search_path = public as $$
declare
  saved public.callback_inbound_calls;
  prior public.callback_leads;
begin
  if p_phone !~ '^\+[1-9][0-9]{6,14}$' then
    raise exception 'A valid caller phone is required';
  end if;
  insert into public.callback_inbound_calls
    (call_sid, phone, called_number, started_at, ended_at, answered_at)
  values (p_call_sid, p_phone, p_called_number, p_started_at, p_ended_at, p_answered_at)
  on conflict (call_sid) do update set
    ended_at = coalesce(callback_inbound_calls.ended_at, excluded.ended_at),
    answered_at = coalesce(callback_inbound_calls.answered_at, excluded.answered_at),
    updated_at = now()
  returning * into saved;

  -- Late delivery of an actual agent join must undo only this call's automatic
  -- callback, never a newer missed call or a row an agent has since changed.
  if saved.answered_at is not null and saved.outcome = 'missed' then
    if saved.previous_lead is null or saved.previous_lead->>'id' is null then
      delete from public.callback_leads
      where source_call_sid = p_call_sid and last_updated_at = saved.finalized_at;
    else
      prior := jsonb_populate_record(null::public.callback_leads, saved.previous_lead);
      update public.callback_leads set
        created_at=prior.created_at, reason=prior.reason, status=prior.status,
        called_at=prior.called_at, called_by=prior.called_by, notes=prior.notes,
        last_updated_at=prior.last_updated_at, called_number=prior.called_number,
        source_call_sid=prior.source_call_sid, digits=prior.digits
      where source_call_sid=p_call_sid and last_updated_at=saved.finalized_at;
    end if;
    update public.callback_inbound_calls set outcome='answered' where call_sid=p_call_sid;
  end if;
end;
$$;
create or replace function public.callback_finalize_inbound()
returns integer language plpgsql security invoker set search_path = public as $$
declare
  item public.callback_inbound_calls;
  prior public.callback_leads;
  finalized_time timestamptz;
  count_done integer := 0;
  was_answered boolean;
begin
  for item in select * from public.callback_inbound_calls
    where finalized_at is null and ended_at < now() - interval '90 seconds'
      and updated_at < now() - interval '15 seconds'
    order by started_at for update skip locked
  loop
    finalized_time := clock_timestamp();
    was_answered := item.answered_at is not null;
    if not was_answered then
      -- Serialize separate calls from the same caller while retaining one row.
      perform pg_advisory_xact_lock(hashtextextended(item.phone, 0));
      select * into prior from public.callback_leads
        where phone_key=regexp_replace(item.phone, '[^0-9]', '', 'g') for update;
      update public.callback_inbound_calls set previous_lead=case when prior.id is not null then to_jsonb(prior) else null end
        where call_sid=item.call_sid;
      insert into public.callback_leads
        (id,phone,phone_key,created_at,name,reason,status,last_updated_at,
         called_number,source_call_sid,digits)
      values (item.call_sid,item.phone,regexp_replace(item.phone, '[^0-9]', '', 'g'),
        item.started_at,'Lead (missed inbound)','missed_inbound','pending',
        finalized_time,item.called_number,item.call_sid,'missed_no_agent')
      on conflict (phone_key) do update set
        created_at=excluded.created_at,reason=excluded.reason,status='pending',
        called_at=null,called_by='',last_updated_at=excluded.last_updated_at,
        called_number=excluded.called_number,source_call_sid=excluded.source_call_sid,
        digits=excluded.digits
      where callback_leads.source_call_sid <> excluded.source_call_sid
        and callback_leads.created_at < excluded.created_at
        and (callback_leads.called_at is null or callback_leads.called_at < excluded.created_at);
    end if;
    update public.callback_inbound_calls set finalized_at=finalized_time,
      outcome=case when was_answered then 'answered' else 'missed' end
      where call_sid=item.call_sid;
    count_done := count_done + 1;
  end loop;
  return count_done;
end;
$$;

revoke all on function public.callback_record_inbound(text,text,text,timestamptz,timestamptz,timestamptz) from public,anon,authenticated;
revoke all on function public.callback_finalize_inbound() from public,anon,authenticated;
grant execute on function public.callback_record_inbound(text,text,text,timestamptz,timestamptz,timestamptz) to service_role;
grant execute on function public.callback_finalize_inbound() to service_role;
