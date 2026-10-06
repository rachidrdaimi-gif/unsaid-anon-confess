-- End-to-end encrypted direct messages. Run once in Supabase > SQL Editor.

-- 1) Keys: public key + passphrase-locked private key (server can't read it).
create table if not exists public.user_keys (
  pseudo_id       text primary key,
  public_key      text not null,
  wrapped_private text not null,
  salt            text not null,
  iv              text not null,
  updated_at      timestamptz not null default now()
);
alter table public.user_keys enable row level security;
-- No policies on purpose: the table is only reachable through the functions below.

create or replace function public.set_my_keys(p_public text, p_wrapped text, p_salt text, p_iv text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare me text;
begin
  me := public.my_pseudo_id();
  if auth.role() <> 'authenticated' or me is null then
    raise exception 'sign in required';
  end if;
  if char_length(coalesce(p_public, '')) not between 50 and 600
     or char_length(coalesce(p_wrapped, '')) not between 50 and 3000
     or char_length(coalesce(p_salt, '')) not between 10 and 100
     or char_length(coalesce(p_iv, '')) not between 10 and 100 then
    raise exception 'invalid key data';
  end if;
  insert into public.user_keys (pseudo_id, public_key, wrapped_private, salt, iv, updated_at)
  values (me, p_public, p_wrapped, p_salt, p_iv, now())
  on conflict (pseudo_id) do update
    set public_key = excluded.public_key,
        wrapped_private = excluded.wrapped_private,
        salt = excluded.salt,
        iv = excluded.iv,
        updated_at = now();
end;
$$;
revoke all on function public.set_my_keys(text, text, text, text) from public, anon;
grant execute on function public.set_my_keys(text, text, text, text) to authenticated;

create or replace function public.my_key_bundle()
returns table (public_key text, wrapped_private text, salt text, iv text)
language sql
stable
security definer
set search_path = public
as $$
  select k.public_key, k.wrapped_private, k.salt, k.iv
  from public.user_keys k
  where k.pseudo_id = public.my_pseudo_id();
$$;
revoke all on function public.my_key_bundle() from public, anon;
grant execute on function public.my_key_bundle() to authenticated;

create or replace function public.get_public_key(p_pseudo text)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select k.public_key from public.user_keys k
  where k.pseudo_id = p_pseudo and auth.role() = 'authenticated';
$$;
revoke all on function public.get_public_key(text) from public, anon;
grant execute on function public.get_public_key(text) to authenticated;

-- 2) Messages are now ciphertext ("e2e1:...") so the old 100-char limit
--    can't apply to the stored text (the app limits the plain text to 100).
alter table public.direct_messages drop constraint if exists dm_content_length;
alter table public.direct_messages
  add constraint dm_content_length check (char_length(content) between 1 and 4000) not valid;

-- 3) Sending: only encrypted payloads are accepted. The server can no longer
--    read messages, so the word filter can't run on them (blocking, bans,
--    "accepts messages" and rate limits all still apply).
create or replace function public.send_direct_message(p_to text, p_content text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  me text;
  clean text;
  new_id uuid;
  sent_last_hour integer;
  new_convos_today integer;
  already_talking boolean;
begin
  if auth.role() <> 'authenticated' then
    raise exception 'sign in required to send messages';
  end if;

  me := public.my_pseudo_id();
  if me is null then
    raise exception 'sign in required to send messages';
  end if;

  if p_to is null or p_to !~ '^#AnonUser[0-9]{4,6}$' then
    raise exception 'invalid recipient';
  end if;

  if public.is_pseudo_banned(me) then
    raise exception 'this account has been banned by a moderator';
  end if;

  if not public.pseudo_accepts_messages(p_to) then
    raise exception 'this person can''t receive messages';
  end if;

  clean := btrim(coalesce(p_content, ''));
  if left(clean, 5) <> 'e2e1:' then
    raise exception 'messages must be encrypted - please refresh the app';
  end if;
  if char_length(clean) > 4000 then
    raise exception 'message too long';
  end if;

  select count(*) into sent_last_hour
    from public.direct_messages
   where sender_pseudo = me and created_at > now() - interval '1 hour';
  if sent_last_hour >= 60 then
    raise exception 'slow down: too many messages in the last hour';
  end if;

  select exists (
    select 1 from public.direct_messages d
     where (d.sender_pseudo = me and d.recipient_pseudo = p_to)
        or (d.sender_pseudo = p_to and d.recipient_pseudo = me)
  ) into already_talking;

  if not already_talking then
    select count(distinct d.recipient_pseudo) into new_convos_today
      from public.direct_messages d
     where d.sender_pseudo = me
       and d.created_at > now() - interval '24 hours';
    if new_convos_today >= 10 then
      raise exception 'slow down: too many new conversations today';
    end if;
  end if;

  insert into public.direct_messages (sender_pseudo, recipient_pseudo, content)
  values (me, p_to, clean)
  returning id into new_id;

  return new_id;
end;
$$;

revoke all on function public.send_direct_message(text, text) from public, anon;
grant execute on function public.send_direct_message(text, text) to authenticated;
