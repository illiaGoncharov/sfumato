-- sfumato: personal word library (one row per sensation)
create table if not exists public.words (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  category text not null check (char_length(category) between 1 and 48),
  detail text not null check (char_length(detail) between 2 and 80),
  created_at timestamptz not null default now()
);

create index if not exists words_user_created on public.words (user_id, created_at);

alter table public.words enable row level security;

create policy "words_select_own" on public.words
  for select using (auth.uid() = user_id);

create policy "words_insert_own" on public.words
  for insert with check (auth.uid() = user_id);

create policy "words_delete_own" on public.words
  for delete using (auth.uid() = user_id);

-- cap library size per user
create or replace function public.enforce_words_limit()
returns trigger
language plpgsql
as $$
begin
  if (select count(*) from public.words where user_id = new.user_id) >= 60 then
    raise exception 'word limit reached (60)';
  end if;
  return new;
end;
$$;

drop trigger if exists words_limit_trigger on public.words;
create trigger words_limit_trigger
  before insert on public.words
  for each row execute function public.enforce_words_limit();
