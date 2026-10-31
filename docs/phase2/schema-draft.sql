-- =====================================================================
-- Movie AI Chatbot Phase 2 — Supabase PostgreSQL スキーマ設計案（rev.2）
--
-- ※ 設計レビュー用の下書き。どの環境でも実行していない（構文も未検証）。
--    実装工程の最初に、ローカルの Supabase（supabase start）で検証してから
--    supabase/migrations/ に分割して取り込む。未検証の前提は detailed-design.md §12 に一覧化。
-- 前提：PostgreSQL 15 以上、btree_gist 拡張
--
-- rev.2 の変更点
--   - showtimes → films の外部キーを NO ACTION（上映回がある作品は削除不可）
--   - 開始済みの上映回は変更・削除不可（上映履歴として保持）
--   - 導出列（starts_at / ends_at / occupied）と作成者・更新者は、トリガーで必ず上書きする（クライアントからの偽装を防ぐ）
--   - 列単位の権限で、クライアントが書ける列を限定する
--   - 公開スケジュールは「終了前」の回を返す（上映中を含む）。is_in_progress を返す
--   - 関数の実行権限を明示的に付与・剥奪する（PUBLIC・anon の既定権限を外す）
--   - 最後の admin のチェックを、館の行ロックで直列化する
--   - 上映回の既定状態は draft（下書き）
-- =====================================================================

create extension if not exists btree_gist;
create schema if not exists private;          -- API（Data API・GraphQL）に公開しないスキーマ
revoke all on schema private from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 列挙型
-- ---------------------------------------------------------------------
create type public.staff_role      as enum ('admin', 'staff');
create type public.film_status     as enum ('draft', 'published', 'archived');   -- 準備中 / 公開中 / 上映終了
create type public.showtime_status as enum ('draft', 'confirmed');               -- 下書き / 確定

-- ---------------------------------------------------------------------
-- 共通トリガー関数（private スキーマ。API から呼べない）
-- ---------------------------------------------------------------------
-- updated_at と作成者・更新者をサーバー側で設定する（クライアントの指定値は無視）
create or replace function private.tg_stamp() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    new.created_at := now();
    new.created_by := (select auth.uid());
  else
    new.created_at := old.created_at;
    new.created_by := old.created_by;
  end if;
  new.updated_at := now();
  new.updated_by := (select auth.uid());
  return new;
end $$;

-- updated_at のみ（作成者を持たないテーブル用）
create or replace function private.tg_set_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- 館に属する行の theater_id を変更させない
create or replace function private.tg_forbid_theater_change() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.theater_id is distinct from old.theater_id then
    raise exception 'theater_id cannot be changed' using errcode = '42501';
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------
-- theaters：映画館（テナント）
-- ---------------------------------------------------------------------
create table public.theaters (
  id                 uuid primary key default gen_random_uuid(),
  slug               text not null unique check (slug ~ '^[a-z0-9-]{3,40}$'),
  name               text not null check (char_length(name) between 1 and 80),
  timezone           text not null default 'Asia/Tokyo',
  business_day_start time not null default '05:00',
  turnover_minutes   int  not null default 15 check (turnover_minutes between 0 and 120),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create trigger theaters_updated_at before update on public.theaters
  for each row execute function private.tg_set_updated_at();

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
  unique (theater_id, id)
);
create trigger screens_updated_at before update on public.screens
  for each row execute function private.tg_set_updated_at();
create trigger screens_theater_fixed before update on public.screens
  for each row execute function private.tg_forbid_theater_change();

-- ---------------------------------------------------------------------
-- theater_staff：所属と権限
-- ---------------------------------------------------------------------
create table public.theater_staff (
  theater_id  uuid not null references public.theaters (id) on delete cascade,
  user_id     uuid not null references auth.users (id) on delete cascade,
  role        public.staff_role not null default 'staff',
  created_at  timestamptz not null default now(),
  primary key (theater_id, user_id)
);
create index theater_staff_user_idx on public.theater_staff (user_id);

-- 各館の最後の admin を削除・降格できない。
--   - 館の行を FOR UPDATE でロックし、admin 同士の同時降格を直列化する
--   - 館そのものの削除（cascade）による削除は許可する
--   - SECURITY DEFINER：auth.users 削除時の cascade（supabase_auth_admin ロール）でも判定できるようにする
create or replace function private.tg_keep_last_admin() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.role = 'admin' and (tg_op = 'DELETE' or new.role <> 'admin') then
    perform 1 from public.theaters where id = old.theater_id for update;
    if found and not exists (
      select 1 from public.theater_staff
       where theater_id = old.theater_id and role = 'admin' and user_id <> old.user_id
    ) then
      raise exception 'theater must keep at least one admin' using errcode = 'P0001';
    end if;
  end if;
  return coalesce(new, old);
end $$;
create trigger theater_staff_keep_admin before update or delete on public.theater_staff
  for each row execute function private.tg_keep_last_admin();
create trigger theater_staff_theater_fixed before update on public.theater_staff
  for each row execute function private.tg_forbid_theater_change();

-- ---------------------------------------------------------------------
-- films：作品
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
  legacy_id        text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  created_by       uuid references auth.users (id) on delete set null,
  updated_by       uuid references auth.users (id) on delete set null,
  unique (theater_id, id),
  unique (theater_id, legacy_id)
);
create index films_theater_status_idx on public.films (theater_id, status);
create trigger films_stamp before insert or update on public.films
  for each row execute function private.tg_stamp();
create trigger films_theater_fixed before update on public.films
  for each row execute function private.tg_forbid_theater_change();

-- ---------------------------------------------------------------------
-- showtimes：上映回
--   入力列：theater_id, film_id, screen_id, business_date, start_time, status
--   導出列：starts_at, ends_at, occupied（トリガーで常に再計算。クライアントは書けない）
-- ---------------------------------------------------------------------
create table public.showtimes (
  id             uuid primary key default gen_random_uuid(),
  theater_id     uuid not null references public.theaters (id) on delete cascade,
  film_id        uuid not null,
  screen_id      uuid,                                    -- null = 未割り当て
  business_date  date not null,
  start_time     time not null,
  status         public.showtime_status not null default 'draft',
  starts_at      timestamptz not null,
  ends_at        timestamptz not null,
  occupied       tstzrange not null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  created_by     uuid references auth.users (id) on delete set null,
  updated_by     uuid references auth.users (id) on delete set null,
  -- 同じ館の作品・シアターしか参照できない（館をまたぐ関連付けの防止）
  -- 作品は NO ACTION：上映回が1件でもあれば作品を削除できない（RESTRICT ではなく NO ACTION にするのは、
  -- 館の削除で films と showtimes が同時に cascade 削除される場合に、文の終わりで判定させるため。要検証）
  foreign key (theater_id, film_id)   references public.films   (theater_id, id) on delete no action,
  foreign key (theater_id, screen_id) references public.screens (theater_id, id) on delete set null (screen_id),
  constraint showtimes_no_overlap exclude using gist (screen_id with =, occupied with &&) where (screen_id is not null)
);
create index showtimes_theater_date_idx on public.showtimes (theater_id, business_date, start_time);
create index showtimes_film_idx         on public.showtimes (film_id, starts_at);
create index showtimes_unassigned_idx   on public.showtimes (theater_id, business_date) where screen_id is null;
create index showtimes_public_idx       on public.showtimes (theater_id, business_date, ends_at) where status = 'confirmed';
create trigger showtimes_stamp before insert or update on public.showtimes
  for each row execute function private.tg_stamp();
create trigger showtimes_theater_fixed before update on public.showtimes
  for each row execute function private.tg_forbid_theater_change();

-- 開始済みの上映回は変更・削除できない（上映履歴として保持）。
--   例外：(1) 館の削除による cascade、(2) シアター削除による未割り当て化（screen_id のみの変更）
create or replace function private.tg_lock_started_showtime() returns trigger
language plpgsql set search_path = '' as $$
begin
  if old.starts_at <= now() then
    if tg_op = 'DELETE' then
      if exists (select 1 from public.theaters where id = old.theater_id) then
        raise exception 'started showtime cannot be deleted' using errcode = 'P0001';
      end if;
      return old;
    end if;
    if new.screen_id is null and old.screen_id is not null
       and (new.film_id, new.business_date, new.start_time, new.status) = (old.film_id, old.business_date, old.start_time, old.status) then
      return new;
    end if;
    raise exception 'started showtime cannot be changed' using errcode = 'P0001';
  end if;
  return coalesce(new, old);
end $$;
create trigger showtimes_lock_started before update or delete on public.showtimes
  for each row execute function private.tg_lock_started_showtime();

-- 営業日 + 開始時刻 → 実時刻・占有時間。INSERT とすべての UPDATE で再計算する（導出列の直接書き換えを無効化）
--   開始時刻が営業日の区切りより前なら翌暦日（例：区切り 05:00、開始 00:30 → 翌日 00:30）
create or replace function private.tg_showtime_compute() returns trigger
language plpgsql set search_path = '' as $$
declare
  t public.theaters%rowtype;
  runtime int;
  local_ts timestamp;
begin
  select * into t from public.theaters where id = new.theater_id;
  if t.id is null then
    raise exception 'theater not accessible' using errcode = '42501';
  end if;
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
-- 名前順でトリガーが実行されるため、lock_started（開始済み判定）→ stamp → z_compute の順になるよう命名する
create trigger showtimes_z_compute before insert or update on public.showtimes
  for each row execute function private.tg_showtime_compute();

-- 作品の上映時間が変わったら、未開始の上映回を再計算する。
-- 重なりが生じる場合は showtimes_no_overlap 違反で作品の更新ごと失敗する（上映回は削除・移動しない）
create or replace function private.tg_film_runtime_changed() returns trigger
language plpgsql set search_path = '' as $$
begin
  update public.showtimes set start_time = start_time        -- showtimes_z_compute を発火させて再計算
   where film_id = new.id and starts_at > now();
  return new;
end $$;
create trigger films_runtime_changed after update of runtime_minutes on public.films
  for each row when (new.runtime_minutes is distinct from old.runtime_minutes)
  execute function private.tg_film_runtime_changed();

-- 入れ替え時間・営業日の区切り・タイムゾーンの変更も、未開始の上映回に反映する（重なれば失敗）
create or replace function private.tg_theater_settings_changed() returns trigger
language plpgsql set search_path = '' as $$
begin
  update public.showtimes set start_time = start_time
   where theater_id = new.id and starts_at > now();
  return new;
end $$;
create trigger theaters_settings_changed after update of turnover_minutes, business_day_start, timezone on public.theaters
  for each row execute function private.tg_theater_settings_changed();

-- ---------------------------------------------------------------------
-- 認可の補助関数（private。SECURITY DEFINER で theater_staff を参照し、RLS の再帰を避ける）
--   返すのは真偽値のみ。引数は uuid のみで、動的 SQL は使わない
-- ---------------------------------------------------------------------
create or replace function private.is_member(tid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.theater_staff s where s.theater_id = tid and s.user_id = (select auth.uid()));
$$;

create or replace function private.is_admin(tid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.theater_staff s
                  where s.theater_id = tid and s.user_id = (select auth.uid()) and s.role = 'admin');
$$;

-- ---------------------------------------------------------------------
-- 権限（GRANT / REVOKE）
--   Supabase は public スキーマの新しいテーブル・関数に anon / authenticated の権限を既定で付与するため、
--   いったん全て剥奪してから必要なものだけ付与する
-- ---------------------------------------------------------------------
revoke all on public.theaters, public.screens, public.theater_staff, public.films, public.showtimes from anon, authenticated;

grant select                                                         on public.theaters      to authenticated;
grant update (name, timezone, business_day_start, turnover_minutes)  on public.theaters      to authenticated;  -- slug は運用者のみ
grant select, delete                                                 on public.screens       to authenticated;
grant insert (theater_id, name, sort_order), update (name, sort_order) on public.screens     to authenticated;
grant select, delete                                                 on public.theater_staff to authenticated;
grant insert (theater_id, user_id, role), update (role)              on public.theater_staff to authenticated;
grant select, delete                                                 on public.films         to authenticated;
grant insert (theater_id, title, synopsis, genres, moods, director, runtime_minutes, status, legacy_id),
      update (title, synopsis, genres, moods, director, runtime_minutes, status)          on public.films     to authenticated;
grant select, delete                                                 on public.showtimes     to authenticated;
grant insert (theater_id, film_id, screen_id, business_date, start_time, status),
      update (film_id, screen_id, business_date, start_time, status)                     on public.showtimes to authenticated;

-- private の関数：認可補助のみ authenticated に実行を許可（スキーマの USAGE も必要）
revoke all on all functions in schema private from public, anon, authenticated;
grant usage on schema private to authenticated;
grant execute on function private.is_member(uuid), private.is_admin(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------
alter table public.theaters      enable row level security;
alter table public.screens       enable row level security;
alter table public.theater_staff enable row level security;
alter table public.films         enable row level security;
alter table public.showtimes     enable row level security;

create policy theaters_select on public.theaters for select to authenticated using (private.is_member(id));
create policy theaters_update on public.theaters for update to authenticated
  using (private.is_admin(id)) with check (private.is_admin(id));

create policy screens_select on public.screens for select to authenticated using (private.is_member(theater_id));
create policy screens_insert on public.screens for insert to authenticated with check (private.is_admin(theater_id));
create policy screens_update on public.screens for update to authenticated
  using (private.is_admin(theater_id)) with check (private.is_admin(theater_id));
create policy screens_delete on public.screens for delete to authenticated using (private.is_admin(theater_id));

create policy staff_select on public.theater_staff for select to authenticated
  using (user_id = (select auth.uid()) or private.is_admin(theater_id));
create policy staff_insert on public.theater_staff for insert to authenticated with check (private.is_admin(theater_id));
create policy staff_update on public.theater_staff for update to authenticated
  using (private.is_admin(theater_id)) with check (private.is_admin(theater_id));
create policy staff_delete on public.theater_staff for delete to authenticated using (private.is_admin(theater_id));

create policy films_select on public.films for select to authenticated using (private.is_member(theater_id));
create policy films_insert on public.films for insert to authenticated with check (private.is_member(theater_id));
create policy films_update on public.films for update to authenticated
  using (private.is_member(theater_id)) with check (private.is_member(theater_id));
create policy films_delete on public.films for delete to authenticated using (private.is_member(theater_id));

create policy showtimes_select on public.showtimes for select to authenticated using (private.is_member(theater_id));
create policy showtimes_insert on public.showtimes for insert to authenticated with check (private.is_member(theater_id));
create policy showtimes_update on public.showtimes for update to authenticated
  using (private.is_member(theater_id)) with check (private.is_member(theater_id));
create policy showtimes_delete on public.showtimes for delete to authenticated using (private.is_member(theater_id));

-- ---------------------------------------------------------------------
-- 利用者サイト向けの公開データ（anon が実行できる唯一の関数）
--   公開条件：作品 = published、上映回 = confirmed、まだ終了していない（上映中を含む）、今日から p_days 日以内
--   シアターの割り当て有無は条件にしない。シアター（スクリーン）名・スタッフ・作成者・下書きは返さない
-- ---------------------------------------------------------------------
create or replace function public.get_public_schedule(p_theater_slug text, p_days int default 7)
returns table (
  theater_name text, today date,
  business_date date, start_time time, starts_at timestamptz, ends_at timestamptz, is_in_progress boolean,
  film_id uuid, legacy_id text, title text, synopsis text, genres text[], moods text[],
  director text, runtime_minutes int
)
language sql stable security definer set search_path = '' as $$
  with th as (
    select t.id, t.name, ((now() at time zone t.timezone) - t.business_day_start)::date as today
      from public.theaters t
     where t.slug = p_theater_slug
  )
  select th.name, th.today,
         s.business_date, s.start_time, s.starts_at, s.ends_at, (s.starts_at <= now()),
         f.id, f.legacy_id, f.title, f.synopsis, f.genres, f.moods, f.director, f.runtime_minutes
    from th
    join public.showtimes s on s.theater_id = th.id
    join public.films f     on f.id = s.film_id and f.theater_id = th.id
   where f.status = 'published'
     and s.status = 'confirmed'
     and s.ends_at > now()
     and s.business_date between th.today and th.today + (least(greatest(coalesce(p_days, 7), 1), 14) - 1)
   order by s.business_date, s.starts_at
   limit 2000;
$$;
revoke all on function public.get_public_schedule(text, int) from public, anon, authenticated;
grant execute on function public.get_public_schedule(text, int) to anon, authenticated;

-- ---------------------------------------------------------------------
-- 管理画面向けの補助（SECURITY INVOKER = RLS が効く。所属外の館では 0 件）
-- ---------------------------------------------------------------------
create or replace function public.find_showtime_conflicts(
  p_theater_id uuid, p_film_id uuid, p_screen_id uuid, p_business_date date, p_start_time time, p_exclude_id uuid default null
) returns table (id uuid, film_id uuid, screen_id uuid, business_date date, start_time time, starts_at timestamptz, ends_at timestamptz)
language plpgsql stable security invoker set search_path = '' as $$
declare
  t public.theaters%rowtype;
  runtime int;
  s timestamptz;
begin
  if p_screen_id is null then return; end if;
  select * into t from public.theaters where theaters.id = p_theater_id;
  select runtime_minutes into runtime from public.films where films.id = p_film_id and films.theater_id = p_theater_id;
  if t.id is null or runtime is null then return; end if;
  s := (p_business_date + p_start_time
        + case when p_start_time < t.business_day_start then interval '1 day' else interval '0' end) at time zone t.timezone;
  return query
    select x.id, x.film_id, x.screen_id, x.business_date, x.start_time, x.starts_at, x.ends_at
      from public.showtimes x
     where x.theater_id = p_theater_id and x.screen_id = p_screen_id
       and (p_exclude_id is null or x.id <> p_exclude_id)
       and x.occupied && tstzrange(s, s + make_interval(mins => runtime + t.turnover_minutes), '[)');
end $$;

-- 上映時間を変えた場合に重なる上映回の組（作品更新前の事前確認用）
create or replace function public.find_runtime_conflicts(p_film_id uuid, p_runtime int)
returns table (showtime_id uuid, other_showtime_id uuid)
language sql stable security invoker set search_path = '' as $$
  with f as (select id, theater_id from public.films where id = p_film_id),
  mine as (
    select s.id, s.screen_id,
           tstzrange(s.starts_at, s.starts_at + make_interval(mins => p_runtime + t.turnover_minutes), '[)') as occ
      from public.showtimes s join f on s.film_id = f.id join public.theaters t on t.id = f.theater_id
     where s.screen_id is not null and s.starts_at > now()
  )
  select m.id, o.id
    from mine m join public.showtimes o
      on o.screen_id = m.screen_id and o.film_id <> p_film_id and o.occupied && m.occ
  union
  select m1.id, m2.id from mine m1 join mine m2 on m1.screen_id = m2.screen_id and m1.id < m2.id and m1.occ && m2.occ;
$$;

revoke all on function public.find_showtime_conflicts(uuid, uuid, uuid, date, time, uuid) from public, anon;
revoke all on function public.find_runtime_conflicts(uuid, int) from public, anon;
grant execute on function public.find_showtime_conflicts(uuid, uuid, uuid, date, time, uuid) to authenticated;
grant execute on function public.find_runtime_conflicts(uuid, int) to authenticated;
