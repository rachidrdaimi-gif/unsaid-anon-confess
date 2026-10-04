-- Optional: enforce the 100-character message limit on the server too.
alter table public.direct_messages drop constraint if exists dm_content_length;
alter table public.direct_messages
  add constraint dm_content_length check (char_length(content) between 1 and 100) not valid;
