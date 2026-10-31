import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { DAYS, GENRES, MOODS, type Genre, type Mood } from "../../shared/films";
import {
  SCREENS, STATUS_LABEL, TURNOVER_MINUTES, assignScreen, describeConflict, fromMinutes, initialFilms, initialShowtimes, isoDate,
  listConflicts, screenName, toMinutes,
  type AdminFilm, type FilmStatus, type Showtime,
} from "./mockData";

type View = "films" | "schedule";
type Confirm = { title: string; body: ReactNode; action: string; onConfirm: () => void } | null;

const todayIso = isoDate(0);
const dateLabel = (iso: string, opts: Intl.DateTimeFormatOptions = { month: "numeric", day: "numeric", weekday: "short" }) =>
  new Intl.DateTimeFormat("ja-JP", opts).format(new Date(`${iso}T00:00:00`));

let seq = 0;
const newId = (prefix: string) => `${prefix}-new-${++seq}`;

export default function AdminApp() {
  const [films, setFilms] = useState<AdminFilm[]>(initialFilms);
  const [showtimes, setShowtimes] = useState<Showtime[]>(() => initialShowtimes());
  const [view, setView] = useState<View>(() => (location.hash === "#schedule" ? "schedule" : "films"));
  const [editing, setEditing] = useState<AdminFilm | "new" | null>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [toast, setToast] = useState("");
  const [scheduleFilm, setScheduleFilm] = useState<string>("all");

  useEffect(() => {
    history.replaceState(null, "", view === "schedule" ? "#schedule" : "#films");
  }, [view]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 3200);
    return () => clearTimeout(t);
  }, [toast]);

  const unassignedCount = showtimes.filter((s) => s.screenId === null).length;
  const notify = (msg: string) => setToast(`${msg}（デモ：保存されません）`);

  function saveFilm(film: AdminFilm, isNew: boolean) {
    const next = isNew ? [...films, film] : films.map((f) => (f.id === film.id ? film : f));
    setFilms(next);
    setEditing(null);
    // 上映時間の変更で既存の上映回が重なっても削除はせず、件数を知らせる
    const conflicts = listConflicts(showtimes, next).size;
    const extra = conflicts > listConflicts(showtimes, films).size ? `。時間が重なる上映回が ${conflicts} 件あります（上映スケジュールで確認してください）` : "";
    notify((isNew ? `「${film.name}」を登録しました` : `「${film.name}」を更新しました`) + extra);
  }

  function requestDeleteFilm(film: AdminFilm) {
    const count = showtimes.filter((s) => s.filmId === film.id).length;
    setConfirm({
      title: "作品を削除しますか？",
      body: (
        <>
          <p><b>{film.name}</b> を削除します。この操作は取り消せません。</p>
          {count > 0 && <p className="warn-text">登録済みの上映予定 {count} 件もあわせて削除されます。上映を終えた作品は「上映終了」に変更すると記録を残せます。</p>}
        </>
      ),
      action: "削除する",
      onConfirm: () => {
        setFilms((list) => list.filter((f) => f.id !== film.id));
        setShowtimes((list) => list.filter((s) => s.filmId !== film.id));
        setEditing(null);
        notify(`「${film.name}」を削除しました`);
      },
    });
  }

  return (
    <div className="admin">
      <header className="admin-top">
        <div className="admin-top-inner">
          <a className="brand" href="#films" aria-label="管理画面トップ">
            <span className="brand-mark" aria-hidden="true">✦</span>
            <span>MOVIE AI <small>THEATER ADMIN</small></span>
          </a>
          <nav className="admin-nav" aria-label="管理メニュー">
            <button type="button" aria-current={view === "films" ? "page" : undefined} onClick={() => setView("films")}>作品管理</button>
            <button type="button" aria-current={view === "schedule" ? "page" : undefined} onClick={() => { setScheduleFilm("all"); setView("schedule"); }}>
              上映スケジュール
              {unassignedCount > 0 && <span className="nav-badge" aria-label={`未割り当て ${unassignedCount}件`}>{unassignedCount}</span>}
            </button>
          </nav>
          <span className="theater-pill" title="ログイン中の映画館（デモ）">◉ シネマ・デモ館</span>
        </div>
      </header>
      <div className="demo-banner" role="note">
        <b>デモ用UIモック</b>：認証は未実装です。変更は保存されず、再読み込みで元に戻ります。作品・上映予定はすべて架空のデータです。
      </div>

      <main className="admin-main">
        {view === "films" ? (
          <FilmsView
            films={films}
            showtimes={showtimes}
            onNew={() => setEditing("new")}
            onEdit={setEditing}
            onDelete={requestDeleteFilm}
            onSchedule={(id) => { setScheduleFilm(id); setView("schedule"); }}
          />
        ) : (
          <ScheduleView
            films={films}
            showtimes={showtimes}
            setShowtimes={setShowtimes}
            filmFilter={scheduleFilm}
            setFilmFilter={setScheduleFilm}
            notify={notify}
            setConfirm={setConfirm}
          />
        )}
      </main>

      {editing && (
        <FilmEditor
          film={editing === "new" ? null : editing}
          showtimeCount={editing === "new" ? 0 : showtimes.filter((s) => s.filmId === editing.id).length}
          onCancel={() => setEditing(null)}
          onSave={saveFilm}
          onDelete={requestDeleteFilm}
        />
      )}
      <ConfirmDialog confirm={confirm} onClose={() => setConfirm(null)} />
      <div className="toast" role="status" aria-live="polite">{toast && <span>{toast}</span>}</div>
    </div>
  );
}

/* ───────── F-01 作品一覧 ───────── */

function FilmsView(props: {
  films: AdminFilm[];
  showtimes: Showtime[];
  onNew: () => void;
  onEdit: (f: AdminFilm) => void;
  onDelete: (f: AdminFilm) => void;
  onSchedule: (id: string) => void;
}) {
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<FilmStatus | "all">("all");
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of props.showtimes) if (s.date >= todayIso) m.set(s.filmId, (m.get(s.filmId) ?? 0) + 1);
    return m;
  }, [props.showtimes]);
  const list = props.films.filter(
    (f) => (status === "all" || f.status === status) && (!q.trim() || `${f.name}${f.director}`.includes(q.trim())),
  );

  return (
    <section aria-labelledby="films-title">
      <div className="page-head">
        <div>
          <div className="eyebrow">FILMS</div>
          <h1 id="films-title">作品管理</h1>
          <p className="page-sub">登録作品 {props.films.length} 本｜公開中 {props.films.filter((f) => f.status === "published").length} 本</p>
        </div>
        <button type="button" className="btn-primary" onClick={props.onNew}>＋ 作品を登録</button>
      </div>

      <div className="toolbar">
        <label className="search">
          <span className="sr-only">作品名・監督で検索</span>
          <input type="search" placeholder="作品名・監督で検索" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        <div className="segmented" role="group" aria-label="公開状態で絞り込み">
          {(["all", "published", "draft", "archived"] as const).map((s) => (
            <button key={s} type="button" aria-pressed={status === s} onClick={() => setStatus(s)}>
              {s === "all" ? "すべて" : STATUS_LABEL[s]}
            </button>
          ))}
        </div>
      </div>

      {list.length === 0 ? (
        <div className="empty"><b>該当する作品がありません</b><span>検索条件を変えるか、新しい作品を登録してください。</span></div>
      ) : (
        <table className="film-table">
          <thead>
            <tr>
              <th scope="col">作品名</th>
              <th scope="col">ジャンル</th>
              <th scope="col">監督</th>
              <th scope="col" className="num">上映時間</th>
              <th scope="col">公開状態</th>
              <th scope="col" className="num">上映予定</th>
              <th scope="col"><span className="sr-only">操作</span></th>
            </tr>
          </thead>
          <tbody>
            {list.map((f) => (
              <tr key={f.id}>
                <th scope="row" className="film-name">
                  <button type="button" className="link-btn" onClick={() => props.onEdit(f)}>{f.name}</button>
                </th>
                <td data-label="ジャンル">{f.genre.join("・")}</td>
                <td data-label="監督">{f.director}</td>
                <td data-label="上映時間" className="num">{f.minutes}分</td>
                <td data-label="公開状態"><span className={`status status-${f.status}`}>{STATUS_LABEL[f.status]}</span></td>
                <td data-label="上映予定" className="num">
                  <button type="button" className="count-btn" onClick={() => props.onSchedule(f.id)} aria-label={`${f.name}の上映予定 ${counts.get(f.id) ?? 0}件を表示`}>
                    {counts.get(f.id) ?? 0}件
                  </button>
                </td>
                <td className="row-actions">
                  <button type="button" className="btn-ghost" onClick={() => props.onEdit(f)}>編集</button>
                  <button type="button" className="btn-ghost danger" onClick={() => props.onDelete(f)}>削除</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="hint">上映予定は今日以降の件数です。件数を押すと、その作品の上映スケジュールを表示します。</p>
    </section>
  );
}

/* ───────── F-02 作品登録・編集 ───────── */

interface FilmDraft {
  name: string;
  synopsis: string;
  genre: Genre[];
  mood: Mood[];
  director: string;
  minutes: string;
  status: FilmStatus;
}

function validateFilm(d: FilmDraft): Partial<Record<keyof FilmDraft, string>> {
  const e: Partial<Record<keyof FilmDraft, string>> = {};
  if (!d.name.trim()) e.name = "作品名を入力してください。";
  else if (d.name.length > 60) e.name = "作品名は60字以内で入力してください。";
  if (d.synopsis.length > 300) e.synopsis = "あらすじは300字以内で入力してください。";
  if (d.genre.length === 0) e.genre = "ジャンルを1つ以上選択してください。";
  if (!d.director.trim()) e.director = "監督名を入力してください。";
  const m = Number(d.minutes);
  if (!Number.isInteger(m) || m < 1 || m > 400) e.minutes = "上映時間は1〜400の整数（分）で入力してください。";
  return e;
}

function FilmEditor(props: {
  film: AdminFilm | null;
  showtimeCount: number;
  onCancel: () => void;
  onSave: (f: AdminFilm, isNew: boolean) => void;
  onDelete: (f: AdminFilm) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const f = props.film;
  const [draft, setDraft] = useState<FilmDraft>({
    name: f?.name ?? "", synopsis: f?.synopsis ?? "", genre: f?.genre ?? [], mood: f?.mood ?? [],
    director: f?.director ?? "", minutes: f ? String(f.minutes) : "", status: f?.status ?? "draft",
  });
  const [errors, setErrors] = useState<ReturnType<typeof validateFilm>>({});
  const set = <K extends keyof FilmDraft>(k: K, v: FilmDraft[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const toggle = <T extends string>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  useEffect(() => {
    ref.current?.showModal();
  }, []);

  function submit(e: FormEvent) {
    e.preventDefault();
    const errs = validateFilm(draft);
    setErrors(errs);
    if (Object.keys(errs).length) {
      ref.current?.querySelector<HTMLElement>("[aria-invalid='true']")?.focus();
      return;
    }
    props.onSave(
      {
        id: f?.id ?? newId("film"), name: draft.name.trim(), synopsis: draft.synopsis.trim(), genre: draft.genre, mood: draft.mood,
        director: draft.director.trim(), minutes: Number(draft.minutes), status: draft.status,
      },
      !f,
    );
  }

  return (
    <dialog ref={ref} className="drawer" aria-labelledby="editor-title" onCancel={(e) => { e.preventDefault(); props.onCancel(); }}>
      <form onSubmit={submit} noValidate>
        <div className="drawer-head">
          <div>
            <div className="eyebrow">{f ? "EDIT FILM" : "NEW FILM"}</div>
            <h2 id="editor-title">{f ? "作品を編集" : "作品を登録"}</h2>
          </div>
          <button type="button" className="icon-btn" aria-label="閉じる" onClick={props.onCancel}>×</button>
        </div>

        <div className="drawer-body">
          <Field id="f-name" label="作品名" required error={errors.name}>
            <input id="f-name" value={draft.name} maxLength={80} onChange={(e) => set("name", e.target.value)} aria-invalid={!!errors.name} aria-describedby={errors.name ? "f-name-err" : undefined} />
          </Field>

          <Field id="f-synopsis" label="あらすじ" error={errors.synopsis} hint={`${draft.synopsis.length}/300字`}>
            <textarea id="f-synopsis" rows={4} value={draft.synopsis} onChange={(e) => set("synopsis", e.target.value)} aria-invalid={!!errors.synopsis} />
          </Field>

          <fieldset className="field">
            <legend>ジャンル <span className="req">必須</span> <small>複数選択可</small></legend>
            <div className="chips" aria-invalid={!!errors.genre}>
              {GENRES.map((g) => (
                <button key={g} type="button" className="chip" aria-pressed={draft.genre.includes(g)} onClick={() => set("genre", toggle(draft.genre, g))}>{g}</button>
              ))}
            </div>
            {errors.genre && <p className="field-error" role="alert">{errors.genre}</p>}
          </fieldset>

          <fieldset className="field">
            <legend>気分タグ <small>おすすめ機能が参照します（任意）</small></legend>
            <div className="chips">
              {MOODS.map((m) => (
                <button key={m} type="button" className="chip" aria-pressed={draft.mood.includes(m)} onClick={() => set("mood", toggle(draft.mood, m))}>{m}</button>
              ))}
            </div>
          </fieldset>

          <div className="field-row">
            <Field id="f-director" label="監督" required error={errors.director}>
              <input id="f-director" value={draft.director} onChange={(e) => set("director", e.target.value)} aria-invalid={!!errors.director} />
            </Field>
            <Field id="f-minutes" label="上映時間" required error={errors.minutes}>
              <div className="with-unit">
                <input id="f-minutes" inputMode="numeric" value={draft.minutes} onChange={(e) => set("minutes", e.target.value.replace(/[^0-9]/g, ""))} aria-invalid={!!errors.minutes} />
                <span>分</span>
              </div>
            </Field>
          </div>

          <fieldset className="field">
            <legend>公開状態</legend>
            <div className="status-options">
              {(["published", "draft", "archived"] as const).map((s) => (
                <label key={s} className="status-option">
                  <input type="radio" name="status" value={s} checked={draft.status === s} onChange={() => set("status", s)} />
                  <span><b>{STATUS_LABEL[s]}</b>
                    <small>{s === "published" ? "利用者サイトのおすすめ・上映予定に表示" : s === "draft" ? "スタッフのみ表示。準備中の作品" : "利用者サイトに表示しない"}</small>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          {f && props.showtimeCount > 0 && <p className="hint">この作品には上映予定が {props.showtimeCount} 件登録されています。</p>}
        </div>

        <div className="drawer-foot">
          {f && <button type="button" className="btn-ghost danger" onClick={() => props.onDelete(f)}>この作品を削除</button>}
          <span className="spacer" />
          <button type="button" className="btn-secondary" onClick={props.onCancel}>キャンセル</button>
          <button type="submit" className="btn-primary">{f ? "変更を保存" : "登録する"}</button>
        </div>
      </form>
    </dialog>
  );
}

function Field(props: { id: string; label: string; required?: boolean; error?: string; hint?: string; children: ReactNode }) {
  return (
    <div className="field">
      <label htmlFor={props.id}>
        {props.label} {props.required && <span className="req">必須</span>}
        {props.hint && <small className="field-hint">{props.hint}</small>}
      </label>
      {props.children}
      {props.error && <p id={`${props.id}-err`} className="field-error" role="alert">{props.error}</p>}
    </div>
  );
}

/* ───────── F-03 上映スケジュール ───────── */

interface ShowDraft {
  filmId: string;
  screenId: string | null;
  date: string;
  start: string;
}

function ScheduleView(props: {
  films: AdminFilm[];
  showtimes: Showtime[];
  setShowtimes: React.Dispatch<React.SetStateAction<Showtime[]>>;
  filmFilter: string;
  setFilmFilter: (id: string) => void;
  notify: (msg: string) => void;
  setConfirm: (c: Confirm) => void;
}) {
  const [date, setDate] = useState(todayIso);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const days = Array.from({ length: DAYS }, (_, i) => isoDate(i));
  const filmById = (id: string) => props.films.find((f) => f.id === id);
  const selectable = props.films.filter((f) => f.status !== "archived");
  const matchesFilter = (s: Showtime) => props.filmFilter === "all" || s.filmId === props.filmFilter;

  const conflicts = useMemo(() => listConflicts(props.showtimes, props.films), [props.showtimes, props.films]);
  const unassignedAll = props.showtimes.filter((s) => s.screenId === null);
  const dayList = props.showtimes
    .filter((s) => s.date === date && matchesFilter(s))
    .sort((a, b) => toMinutes(a.start) - toMinutes(b.start));
  const dayUnassigned = dayList.filter((s) => s.screenId === null);

  function save(d: ShowDraft, id?: string): string | null {
    if (!d.filmId) return "作品を選択してください。";
    if (!/^\d{2}:\d{2}$/.test(d.start)) return "開始時刻を入力してください。";
    const reason = describeConflict({ ...d, id }, props.showtimes, props.films);
    if (reason) return reason;
    props.setShowtimes((list) => (id ? list.map((s) => (s.id === id ? { ...s, ...d } : s)) : [...list, { ...d, id: newId("show") }]));
    props.notify(`${dateLabel(d.date)} ${d.start}「${filmById(d.filmId)?.name}」を${id ? "更新" : "追加"}しました`);
    setAdding(false);
    setEditingId(null);
    if (d.date !== date) setDate(d.date);
    return null;
  }

  function assign(s: Showtime, screenId: string): string | null {
    const result = assignScreen(props.showtimes, s.id, screenId, props.films);
    if (!result.ok) return result.reason;
    props.setShowtimes(result.showtimes);
    props.notify(`${s.start}「${filmById(s.filmId)?.name}」を${screenName(screenId)}に割り当てました`);
    return null;
  }

  function remove(s: Showtime) {
    const f = filmById(s.filmId);
    props.setConfirm({
      title: "上映予定を削除しますか？",
      body: <p>{dateLabel(s.date)} {s.start}〜 <b>{f?.name}</b>（{screenName(s.screenId)}）を削除します。</p>,
      action: "削除する",
      onConfirm: () => {
        props.setShowtimes((list) => list.filter((x) => x.id !== s.id));
        props.notify("上映予定を削除しました");
      },
    });
  }

  const renderShow = (s: Showtime) => {
    const f = filmById(s.filmId);
    if (editingId === s.id) {
      return (
        <li key={s.id}>
          <ShowForm title="上映回を編集" films={selectable} initial={s} compact onCancel={() => setEditingId(null)} onSave={(d) => save(d, s.id)} />
        </li>
      );
    }
    const conflict = conflicts.get(s.id);
    return (
      <li key={s.id} className={`show ${f?.status !== "published" ? "is-muted" : ""} ${conflict ? "is-conflict" : ""}`}>
        <div className="show-time">
          <b>{s.start}</b>
          <span>〜{f ? fromMinutes(toMinutes(s.start) + f.minutes) : "--:--"}</span>
        </div>
        <div className="show-film">
          <b>{f?.name ?? "（削除された作品）"}</b>
          <span>{f?.minutes}分{f && f.status !== "published" ? `｜${STATUS_LABEL[f.status]}` : ""}</span>
        </div>
        {conflict && <p className="show-warn" role="note">⚠ 重複：{conflict}</p>}
        {s.screenId === null && <AssignControl show={s} onAssign={(screenId) => assign(s, screenId)} />}
        <div className="show-actions">
          <button type="button" className="btn-ghost" onClick={() => { setEditingId(s.id); setAdding(false); }} aria-label={`${s.start} ${f?.name} を編集`}>編集</button>
          <button type="button" className="btn-ghost danger" onClick={() => remove(s)} aria-label={`${s.start} ${f?.name} を削除`}>削除</button>
        </div>
      </li>
    );
  };

  return (
    <section aria-labelledby="schedule-title">
      <div className="page-head">
        <div>
          <div className="eyebrow">SCHEDULE</div>
          <h1 id="schedule-title">上映スケジュール</h1>
          <p className="page-sub">日付を選んで、上映回の追加・編集・削除やシアターの割り当てができます。</p>
        </div>
        <button type="button" className="btn-primary" onClick={() => { setAdding(true); setEditingId(null); }} disabled={adding}>＋ 上映回を追加</button>
      </div>

      {(unassignedAll.length > 0 || conflicts.size > 0) && (
        <div className="alert" role="status">
          <div>
            {unassignedAll.length > 0 && <p><b>シアター未割り当ての上映回が {unassignedAll.length} 件あります。</b>上映回は削除されていません。シアターを選んで割り当ててください。</p>}
            {conflicts.size > 0 && <p><b>時間が重なっている上映回が {conflicts.size} 件あります。</b>各上映回に原因を表示しています。</p>}
          </div>
          {unassignedAll.length > 0 && (
            <div className="alert-dates" aria-label="未割り当てがある日">
              {days.filter((d) => unassignedAll.some((s) => s.date === d)).map((d) => (
                <button key={d} type="button" className="alert-date" aria-pressed={d === date} onClick={() => setDate(d)}>
                  {dateLabel(d)} <b>{unassignedAll.filter((s) => s.date === d).length}件</b>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="date-strip admin-dates" role="group" aria-label="日付を選択">
        {days.map((d, i) => {
          const list = props.showtimes.filter((s) => s.date === d && matchesFilter(s));
          const un = list.filter((s) => s.screenId === null).length;
          return (
            <button key={d} type="button" className="date" aria-pressed={d === date} onClick={() => setDate(d)}>
              <span>{i === 0 ? "今日" : dateLabel(d, { weekday: "short" })}</span>
              <b>{dateLabel(d, { month: "numeric", day: "numeric" })}</b>
              <small className="date-count">{list.length}回</small>
              {un > 0 && <small className="date-unassigned">未割当 {un}</small>}
            </button>
          );
        })}
      </div>

      <div className="toolbar">
        <h2 className="day-title">{dateLabel(date, { month: "long", day: "numeric", weekday: "long" })}</h2>
        <label className="inline-select">
          <span>作品で絞り込み</span>
          <select value={props.filmFilter} onChange={(e) => props.setFilmFilter(e.target.value)}>
            <option value="all">すべての作品</option>
            {props.films.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        </label>
      </div>

      {adding && (
        <ShowForm
          title="上映回を追加"
          films={selectable}
          initial={{ filmId: props.filmFilter !== "all" ? props.filmFilter : "", screenId: SCREENS[0].id, date, start: "" }}
          onCancel={() => setAdding(false)}
          onSave={(d) => save(d)}
        />
      )}

      {dayUnassigned.length > 0 && (
        <div className="unassigned">
          <h3>未割り当て <small>{dayUnassigned.length}回｜シアターを選んで「割り当て」を押してください</small></h3>
          <ol className="show-list unassigned-list">{dayUnassigned.map(renderShow)}</ol>
        </div>
      )}

      <div className="screens">
        {SCREENS.map((sc) => {
          const rows = dayList.filter((s) => s.screenId === sc.id);
          return (
            <div key={sc.id} className="screen-col">
              <h3>{sc.name} <small>{rows.length}回</small></h3>
              {rows.length === 0 && <p className="screen-empty">上映予定はありません</p>}
              <ol className="show-list">{rows.map(renderShow)}</ol>
            </div>
          );
        })}
      </div>
      <p className="hint">終了時刻は上映時間から自動計算します。同じシアターでは、終了後{TURNOVER_MINUTES}分の入れ替え時間を空けて登録してください。重なりのある上映回や未割り当ての上映回が自動で削除されることはありません。</p>
    </section>
  );
}

function AssignControl(props: { show: Showtime; onAssign: (screenId: string) => string | null }) {
  const [screenId, setScreenId] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="assign">
      <label>
        <span className="sr-only">{props.show.start}の割り当て先シアター</span>
        <select value={screenId} onChange={(e) => { setScreenId(e.target.value); setError(null); }}>
          <option value="">シアターを選択</option>
          {SCREENS.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </label>
      <button type="button" className="btn-secondary" disabled={!screenId} onClick={() => setError(props.onAssign(screenId))}>割り当て</button>
      {error && <p className="field-error" role="alert">{error}</p>}
    </div>
  );
}

function ShowForm(props: {
  title: string;
  films: AdminFilm[];
  initial: ShowDraft;
  compact?: boolean;
  onCancel: () => void;
  onSave: (d: ShowDraft) => string | null;
}) {
  const [d, setD] = useState<ShowDraft>({ filmId: props.initial.filmId, screenId: props.initial.screenId, date: props.initial.date, start: props.initial.start });
  const [error, setError] = useState<string | null>(null);
  const film = props.films.find((f) => f.id === d.filmId);
  const end = film && /^\d{2}:\d{2}$/.test(d.start) ? fromMinutes(toMinutes(d.start) + film.minutes) : null;
  const set = <K extends keyof ShowDraft>(k: K, v: ShowDraft[K]) => { setD((x) => ({ ...x, [k]: v })); setError(null); };
  const days = Array.from({ length: DAYS }, (_, i) => isoDate(i));

  return (
    <form className={`show-form ${props.compact ? "compact" : ""}`} onSubmit={(e) => { e.preventDefault(); setError(props.onSave(d)); }} aria-label={props.title}>
      {!props.compact && <h3>{props.title}</h3>}
      <div className="show-form-grid">
        <label>作品
          <select value={d.filmId} onChange={(e) => set("filmId", e.target.value)} autoFocus>
            <option value="">選択してください</option>
            {props.films.map((f) => <option key={f.id} value={f.id}>{f.name}（{f.minutes}分）</option>)}
          </select>
        </label>
        <label>上映日
          <select value={d.date} onChange={(e) => set("date", e.target.value)}>
            {days.map((x) => <option key={x} value={x}>{dateLabel(x)}</option>)}
          </select>
        </label>
        <label>シアター
          <select value={d.screenId ?? ""} onChange={(e) => set("screenId", e.target.value || null)}>
            {SCREENS.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            <option value="">未割り当て</option>
          </select>
        </label>
        <label>開始時刻
          <input type="time" step={300} value={d.start} onChange={(e) => set("start", e.target.value)} />
        </label>
      </div>
      <p className="end-time" aria-live="polite">{end ? `終了予定 ${end}（${film!.minutes}分）` : "作品と開始時刻を選ぶと終了時刻を表示します"}</p>
      {error && <p className="field-error" role="alert">{error}</p>}
      <div className="show-form-actions">
        <button type="button" className="btn-secondary" onClick={props.onCancel}>キャンセル</button>
        <button type="submit" className="btn-primary">保存</button>
      </div>
    </form>
  );
}

/* ───────── 確認ダイアログ ───────── */

function ConfirmDialog({ confirm, onClose }: { confirm: Confirm; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (confirm && !d.open) d.showModal();
    if (!confirm && d.open) d.close();
  }, [confirm]);
  return (
    <dialog ref={ref} className="confirm" aria-labelledby="confirm-title" onClose={onClose}>
      {confirm && (
        <div className="confirm-body">
          <h2 id="confirm-title">{confirm.title}</h2>
          {confirm.body}
          <div className="confirm-actions">
            <button type="button" className="btn-secondary" onClick={onClose} autoFocus>キャンセル</button>
            <button type="button" className="btn-danger" onClick={() => { confirm.onConfirm(); onClose(); }}>{confirm.action}</button>
          </div>
        </div>
      )}
    </dialog>
  );
}
