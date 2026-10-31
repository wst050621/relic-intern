-- =====================================================================
-- Movie AI Chatbot Phase 2 — Supabase PostgreSQL スキーマ設計案
--
-- ※ 設計レビュー用の下書き。どの環境でも実行していない（構文も未検証）。
--    実装工程の最初に、ローカルの Supabase（supabase start）で検証してから
--    supabase/migrations/ に分割して取り込む。
-- 前提：PostgreSQL 15 以上（ON DELETE SET NULL の列指定を使うため）、btree_gist 拡張
-- =====================================================================

create extension if not exists btree_gist;

-- ---------------------------------------------------------------------
-- 列挙型
-- ---------------------------------------------------------------------
create type public.staff_role       as enum ('admin', 'staff');
create type public.film_status      as enum ('draft', 'published', 'archived');  -- 準備中 / 公開中 / 上映終了
create type public.showtime_status  as enum ('draft', 'confirmed');              -- 下書き / 確定

-- ---------------------------------------------------------------------
-- 共通：updated_at の自動更新、theater_id の変更禁止
-- ---------------------------------------------------------------------
create or replace function public.tg_set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

create or replace function public.tg_forbid_theater_change() returns trigger
language plpgsql as $$
begin
  if new.theater_id is distinct from old.theater_id then
    raise exception 'theater_id cannot be changed' using errcode = 'P0001';
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------
-- theaters：映画館（テナント）
-- ---------------------------------------------------------------------
create table public.theaters (
  id                 uuid primary key default gen_random_uuid(),
  slug               text not null unique check (slug ~ '^[a-z0-9-]{3,40}$'),   -- 公開サイトでの識別子
  name               text not null check (char_length(name) between 1 and 80),
  timezone           text not null default 'Asia/Tokyo',
  business_day_start time not null default '05:00',                             -- 営業日の区切り（深夜上映の帰属先）
  turnover_minutes   int  not null default 15 check (turnover_minutes between 0 and 120),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create trigger theaters_updated_at before update on public.theaters
  for each row execute function public.tg_set_updated_at();

-- ---------------------------------------------------------------------
-- screens：シアター（館ごとに 1〜N 件）
-- ---------------------------------------------------------------------
create table public.screens (
  id          uuid primary key default gen_random_uuid(),
  theater_id  uuid not null references public.theaters (id) on delete cascade,
  name        text not null check (char_length(name) between 1 and 40),
  sort_order  int  not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (theater_id, name),
  unique (theater_id, id)              -- 複合外部キー（館をまたぐ関連付けの防止）の参照先
);
create trigger screens_updated_at before update on public.screens
  for each row execute function public.tg_set_updated_at();
create trigger screens_theater_fixed before update on public.screens
  for each row execute function public.tg_forbid_theater_change();

-- ---------------------------------------------------------------------
-- theater_staff：スタッフの所属と権限
-- ---------------------------------------------------------------------
create table public.theater_staff (
  theater_id  uuid not null references public.theaters (id) on delete cascade,
  user_id     uuid not null references auth.users (id) on delete cascade,
  role        public.staff_role not null default 'staff',
  created_at  timestamptz not null default now(),
  primary key (theater_id, user_id)
);
create index theater_staff_user_idx on public.theater_staff (user_id);

-- 各館の最後の admin を削除・降格できないようにする
create or replace function public.tg_keep_last_admin() returns trigger
language plpgsql as $$
begin
  if old.role = 'admin' and (tg_op = 'DELETE' or new.role <> 'admin')
     -- 館そのものの削除（on delete cascade）による削除は許可する
     and exists (select 1 from public.theaters where id = old.theater_id) then
    if not exists (
      select 1 from public.theater_staff
      where theater_id = old.theater_id and role = 'admin' and user_id <> old.user_id
    ) then
      raise exception 'theater must keep at least one admin' using errcode = 'P0001';
    end if;
  end if;
  return coalesce(new, old);
end $$;
create trigger theater_staff_keep_admin before update or delete on public.theater_staff
  for each row execute function public.tg_keep_last_admin();

-- ---------------------------------------------------------------------
-- films：作品（館ごと）
-- ---------------------------------------------------------------------
create table public.films (
  id               uuid primary key default gen_random_uuid(),
  theater_id       uuid not null references public.theaters (id) on delete cascade,
  title            text not null check (char_length(btrim(title)) between 1 and 60),
  synopsis         text not null default '' check (char_length(synopsis) <= 300),
  genres           text[] not null check (
                     cardinality(genres) >= 1 and
                     genres <@ array['ドラマ','アニメ','SF','サスペンス','コメディ','恋愛','ホラー','音楽','ファンタジー']::text[]),
  moods            text[] not null default '{}' check (
                     moods <@ array['感動したい','笑いたい','ドキドキしたい','ほっこりしたい','じっくり観たい','家族で楽しむ']::text[]),
  director         text not null check (char_length(btrim(director)) between 1 and 60),
  runtime_minutes  int  not null check (runtime_minutes between 1 and 400),
  status           public.film_status not null default 'draft',
  legacy_id        text,                                   -- 移行元 shared/films.ts の id（例 'kitchen'）
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  created_by       uuid references auth.users (id) on delete set null,
  updated_by       uuid references auth.users (id) on delete set null,
  unique (theater_id, id),
  unique (theater_id, legacy_id)
);
create index films_theater_status_idx on public.films (theater_id, status);
create trigger films_updated_at before update on public.films
  for each row execute function public.tg_set_updated_at();
create trigger films_theater_fixed before update on public.films
  for each row execute function public.tg_forbid_theater_change();

-- ---------------------------------------------------------------------
-- showtimes：上映回
--   入力値：business_date（営業日）+ start_time（現地の開始時刻）
--   導出値：starts_at / ends_at / occupied（トリガーで計算。API からは書き込まない）
-- ---------------------------------------------------------------------
create table public.showtimes (
  id             uuid primary key default gen_random_uuid(),
  theater_id     uuid not null references public.theaters (id) on delete cascade,
  film_id        uuid not null,
  screen_id      uuid,                                   -- null = 未割り当て（上映回は保持する）
  business_date  date not null,
  start_time     time not null,
  status         public.showtime_status not null default 'draft',
  starts_at      timestamptz not null,
  ends_at        timestamptz not null,                   -- 本編終了（starts_at + 上映時間）
  occupied       tstzrange not null,                     -- [starts_at, ends_at + 入れ替え時間)
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  created_by     uuid references auth.users (id) on delete set null,
  updated_by     uuid references auth.users (id) on delete set null,
  -- 館をまたぐ関連付けを DB で禁止する（作品・シアターは同じ theater_id のものだけ）
  foreign key (theater_id, film_id)   references public.films   (theater_id, id) on delete cascade,
  foreign key (theater_id, screen_id) references public.screens (theater_id, id) on delete set null (screen_id),
  -- 同じシアターで時間が重なる上映回を禁止（未割り当ては対象外）。下書きも枠を占有する
  constraint showtimes_no_overlap exclude using gist (screen_id with =, occupied with &&) where (screen_id is not null)
);
create index showtimes_theater_date_idx on public.showtimes (theater_id, business_date, start_time);
create index showtimes_film_idx         on public.showtimes (film_id, starts_at);
create index showtimes_unassigned_idx   on public.showtimes (theater_id, business_date) where screen_id is null;
create trigger showtimes_updated_at before update on public.showtimes
  for each row execute function public.tg_set_updated_at();
create trigger showtimes_theater_fixed before update on public.showtimes
  for each row execute function public.tg_forbid_theater_change();

-- 営業日 + 開始時刻 → 実時刻。開始時刻が営業日の区切りより前なら翌暦日（例：区切り 05:00、開始 00:30 → 翌日 00:30）
create or replace function public.tg_showtime_compute() returns trigger
language plpgsql as $$
declare
  t public.theaters%rowtype;
  runtime int;
  local_ts timestamp;
begin
  select * into t from public.theaters where id = new.theater_id;
  select runtime_minutes into runtime from public.films where id = new.film_id and theater_id = new.theater_id;
  if runtime is null then
    raise exception 'film not found in this theater' using errcode = '23503';
  end if;
  local_ts := new.business_date + new.start_time
              + case when new.start_time < t.business_day_start then interval '1 day' else interval '0' end;
  new.starts_at := local_ts at time zone t.timezone;
  new.ends_at   := new.starts_at + make_interval(mins => runtime);
  new.occupied  := tstzrange(new.starts_at, new.ends_at + make_interval(mins => t.turnover_minutes), '[)');
  return new;
end $$;
create trigger showtimes_compute before insert or update of business_date, start_time, film_id, screen_id
  on public.showtimes for each row execute function public.tg_showtime_compute();

-- 作品の上映時間が変わったら、今後の上映回の占有時間を再計算する。
-- 重なりが生じる場合は showtimes_no_overlap 違反で作品の更新ごと失敗する（上映回は削除・移動しない）
create or replace function public.tg_film_runtime_changed() returns trigger
language plpgsql as $$
begin
  update public.showtimes s
     set ends_at  = s.starts_at + make_interval(mins => new.runtime_minutes),
         occupied = tstzrange(s.starts_at,
                              s.starts_at + make_interval(mins => new.runtime_minutes + t.turnover_minutes), '[)')
    from public.theaters t
   where s.film_id = new.id and t.id = s.theater_id and s.ends_at >= now();
  return new;
end $$;
create trigger films_runtime_changed after update of runtime_minutes on public.films
  for each row when (new.runtime_minutes is distinct from old.runtime_minutes)
  execute function public.tg_film_runtime_changed();

-- 入れ替え時間・営業日の区切り・タイムゾーンの変更も、今後の上映回へ反映する（重なれば失敗）
create or replace function public.tg_theater_settings_changed() returns trigger
language plpgsql as $$
begin
  update public.showtimes s
     set start_time = s.start_time        -- showtimes_compute トリガーを発火させて再計算する
   where s.theater_id = new.id and s.ends_at >= now();
  return new;
end $$;
create trigger theaters_settings_changed after update of turnover_minutes, business_day_start, timezone on public.theaters
  for each row execute function public.tg_theater_settings_changed();

-- ---------------------------------------------------------------------
-- 認可用の補助関数（API に公開されない private スキーマに置く）
-- ---------------------------------------------------------------------
create schema if not exists private;

create or replace function private.is_member(tid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.theater_staff s where s.theater_id = tid and s.user_id = (select auth.uid()));
$$;

create or replace function private.is_admin(tid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.theater_staff s
                 where s.theater_id = tid and s.user_id = (select auth.uid()) and s.role = 'admin');
$$;

revoke all on schema private from public, anon;
grant usage on schema private to authenticated;
grant execute on function private.is_member(uuid), private.is_admin(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- RLS：未認証（anon）はテーブルに一切アクセスできない。認証済みは自館のみ
-- ---------------------------------------------------------------------
alter table public.theaters      enable row level security;
alter table public.screens       enable row level security;
alter table public.theater_staff enable row level security;
alter table public.films         enable row level security;
alter table public.showtimes     enable row level security;

revoke all on public.theaters, public.screens, public.theater_staff, public.films, public.showtimes from anon;

-- theaters：所属スタッフが参照、admin が設定を更新。作成・削除は運用者のみ（ポリシーなし）
create policy theaters_select on public.theaters for select to authenticated using (private.is_member(id));
create policy theaters_update on public.theaters for update to authenticated
  using (private.is_admin(id)) with check (private.is_admin(id));

-- screens：所属スタッフが参照、admin が追加・変更・削除
create policy screens_select on public.screens for select to authenticated using (private.is_member(theater_id));
create policy screens_write  on public.screens for all to authenticated
  using (private.is_admin(theater_id)) with check (private.is_admin(theater_id));

-- theater_staff：本人の所属は本人が参照、館のスタッフ一覧と変更は admin のみ
create policy staff_select on public.theater_staff for select to authenticated
  using (user_id = (select auth.uid()) or private.is_admin(theater_id));
create policy staff_write  on public.theater_staff for all to authenticated
  using (private.is_admin(theater_id)) with check (private.is_admin(theater_id));

-- films / showtimes：所属スタッフ（admin・staff）が参照・作成・更新・削除
create policy films_all on public.films for all to authenticated
  using (private.is_member(theater_id)) with check (private.is_member(theater_id));
create policy showtimes_all on public.showtimes for all to authenticated
  using (private.is_member(theater_id)) with check (private.is_member(theater_id));

-- ---------------------------------------------------------------------
-- 利用者サイト向けの公開データ取得（anon が実行できる唯一の入口）
--   公開条件：作品 = published、上映回 = confirmed、未開始、今日から p_days 日以内
--   シアターの割り当て有無は条件にしない
-- ---------------------------------------------------------------------
create or replace function public.get_public_schedule(p_theater_slug text, p_days int default 7)
returns table (
  theater_name text, timezone text, today date,
  business_date date, start_time time, starts_at timestamptz,
  film_id uuid, legacy_id text, title text, synopsis text, genres text[], moods text[],
  director text, runtime_minutes int
)
language sql stable security definer set search_path = '' as $$
  with th as (
    select t.*, ((now() at time zone t.timezone) - t.business_day_start)::date as today
      from public.theaters t where t.slug = p_theater_slug
  )
  select th.name, th.timezone, th.today,
         s.business_date, s.start_time, s.starts_at,
         f.id, f.legacy_id, f.title, f.synopsis, f.genres, f.moods, f.director, f.runtime_minutes
    from th
    join public.showtimes s on s.theater_id = th.id
    join public.films f     on f.id = s.film_id and f.theater_id = th.id
   where f.status = 'published'
     and s.status = 'confirmed'
     and s.starts_at > now()
     and s.business_date between th.today and th.today + (least(greatest(p_days, 1), 14) - 1)
   order by s.business_date, s.starts_at;
$$;
revoke all on function public.get_public_schedule(text, int) from public;
grant execute on function public.get_public_schedule(text, int) to anon, authenticated;

-- ---------------------------------------------------------------------
-- 管理画面向けの補助（security invoker = RLS が効く）
-- ---------------------------------------------------------------------
-- 上映回の登録前の重なり確認（UI の事前警告用。最終判定は showtimes_no_overlap）
create or replace function public.find_showtime_conflicts(
  p_theater_id uuid, p_film_id uuid, p_screen_id uuid, p_business_date date, p_start_time time, p_exclude_id uuid default null
) returns setof public.showtimes
language plpgsql stable security invoker set search_path = '' as $$
declare
  t public.theaters%rowtype;
  runtime int;
  s timestamptz;
begin
  if p_screen_id is null then return; end if;
  select * into t from public.theaters where id = p_theater_id;
  select runtime_minutes into runtime from public.films where id = p_film_id and theater_id = p_theater_id;
  if t.id is null or runtime is null then return; end if;
  s := (p_business_date + p_start_time
        + case when p_start_time < t.business_day_start then interval '1 day' else interval '0' end) at time zone t.timezone;
  return query
    select * from public.showtimes x
     where x.theater_id = p_theater_id and x.screen_id = p_screen_id
       and (p_exclude_id is null or x.id <> p_exclude_id)
       and x.occupied && tstzrange(s, s + make_interval(mins => runtime + t.turnover_minutes), '[)');
end $$;

-- 上映時間の変更で重なる上映回の一覧（作品更新前の事前確認用）
create or replace function public.find_runtime_conflicts(p_film_id uuid, p_runtime int)
returns table (showtime_id uuid, other_showtime_id uuid)
language sql stable security invoker set search_path = '' as $$
  with f as (select id, theater_id from public.films where id = p_film_id),
  mine as (
    select s.id, s.screen_id,
           tstzrange(s.starts_at, s.starts_at + make_interval(mins => p_runtime + t.turnover_minutes), '[)') as occ
      from public.showtimes s join f on s.film_id = f.id join public.theaters t on t.id = f.theater_id
     where s.screen_id is not null and s.ends_at >= now()
  )
  select m.id, o.id
    from mine m join public.showtimes o
      on o.screen_id = m.screen_id and o.id <> m.id and o.film_id <> p_film_id and o.occupied && m.occ
  union
  select m1.id, m2.id from mine m1 join mine m2 on m1.screen_id = m2.screen_id and m1.id < m2.id and m1.occ && m2.occ;
$$;
