begin;
do $test$
declare
  a text := 'CA' || repeat('f',32);
  b text := 'CA' || repeat('e',32);
  c text := 'CA' || repeat('d',32);
  n text := '+15550000001';
  d timestamptz := now()-interval '20 minutes';
begin
  if exists(select 1 from callback_leads where phone=n) then raise exception 'Test number collision'; end if;
  perform callback_record_inbound(a,n,'+18555077602',d,d+interval '10 seconds',null);
  update callback_inbound_calls set updated_at=d where call_sid=a;
  perform callback_finalize_inbound();
  if not exists(select 1 from callback_leads where source_call_sid=a and status='pending') then raise exception 'Early hangup not captured'; end if;
  perform callback_record_inbound(a,n,'+18555077602',d,d+interval '10 seconds',d+interval '2 seconds');
  if exists(select 1 from callback_leads where source_call_sid=a) then raise exception 'Late answer not removed'; end if;

  perform callback_record_inbound(b,n,'+18555077602',d+interval '1 minute',d+interval '2 minutes',null);
  update callback_inbound_calls set updated_at=d where call_sid=b;
  perform callback_finalize_inbound();
  update callback_leads set notes='Keep these notes',status='called',called_at=d+interval '3 minutes',last_updated_at=now() where phone=n;
  perform callback_record_inbound(b,n,'+18555077602',d+interval '1 minute',d+interval '2 minutes',null);
  perform callback_finalize_inbound();
  if not exists(select 1 from callback_leads where phone=n and status='called') then raise exception 'Replay reopened handled lead'; end if;

  perform callback_record_inbound(c,n,'+18444844459',d+interval '4 minutes',d+interval '5 minutes',null);
  update callback_inbound_calls set updated_at=d where call_sid=c;
  perform callback_finalize_inbound();
  if (select count(*) from callback_leads where phone=n)<>1 then raise exception 'Duplicate caller'; end if;
  if not exists(select 1 from callback_leads where phone=n and source_call_sid=c and id=b and notes='Keep these notes' and status='pending') then raise exception 'Repeat call did not preserve identity/notes'; end if;
  perform callback_record_inbound(c,n,'+18444844459',d+interval '4 minutes',d+interval '5 minutes',d+interval '4 minutes');
  if not exists(select 1 from callback_leads where phone=n and source_call_sid=b and status='called' and notes='Keep these notes') then raise exception 'Late retry answer did not restore previous lead'; end if;
end $test$;
rollback;
