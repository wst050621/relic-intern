// UIモック用のメモリ内データ。既存の架空作品（shared/films.ts）から生成し、永続化はしない
import { DAYS, FILMS, timesFor, type Genre, type Mood } from "../../shared/films";

export type FilmStatus = "published" | "draft" | "archived";

export const STATUS_LABEL: Record<FilmStatus, string> = {
  published: "公開中",
  draft: "準備中",
  archived: "上映終了",
};

export interface AdminFilm {
  id: string;
  name: string;
  synopsis: string;
  genre: Genre[];
  mood: Mood[];
  director: string;
  minutes: number;
  status: FilmStatus;
}

export type ShowtimeStatus = "draft" | "confirmed";

export interface Showtime {
  id: string;
  filmId: string;
  /** null = 未割り当て（シアター未定）。上映回そのものは保持する */
  screenId: string | null;
  /** 下書き = 利用者サイトの公開候補にしない。確定 = 公開候補 */
  status: ShowtimeStatus;
  date: string; // YYYY-MM-DD（劇場のローカル日付）
  start: string; // HH:MM
}

export interface Screen {
  id: string;
  name: string;
}

export const SCREENS: Screen[] = [
  { id: "s1", name: "シアター1" },
  { id: "s2", name: "シアター2" },
  { id: "s3", name: "シアター3" },
];

/** 上映の入れ替え・清掃に必要な間隔（分） */
export const TURNOVER_MINUTES = 15;

export function isoDate(offset: number, base = new Date()): string {
  const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function initialFilms(): AdminFilm[] {
  return FILMS.map((f) => ({
    id: f.id, name: f.name, synopsis: f.synopsis, genre: [...f.genre], mood: [...f.mood],
    director: f.director, minutes: f.minutes, status: "published",
  }));
}

/**
 * 既存の架空上映時刻を、すべて上映回として保持したうえでシアターへ割り当てる。
 * 既存データはシアターを想定しておらず同時刻帯が多いため、空きシアターがない回は「未割り当て」（screenId = null）にする。
 * 上映回を除外・削除することはしない
 */
export function initialShowtimes(films: AdminFilm[] = initialFilms()): Showtime[] {
  const list: Showtime[] = [];
  for (let day = 0; day < DAYS; day++) {
    const items = FILMS.flatMap((f) => timesFor(f, day).map((start) => ({ filmId: f.id, start })))
      .sort((a, b) => toMinutes(a.start) - toMinutes(b.start));
    for (const it of items) {
      const base = { filmId: it.filmId, date: isoDate(day), start: it.start };
      const screen = SCREENS.find((sc) => !findConflict({ ...base, screenId: sc.id }, list, films));
      list.push({ ...base, id: `${it.filmId}-${day}-${it.start}`, screenId: screen?.id ?? null, status: "confirmed" });
    }
  }
  return list;
}

export const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};
export const fromMinutes = (n: number) => `${String(Math.floor(n / 60) % 24).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;

type Candidate = Omit<Showtime, "id" | "status"> & { id?: string };

/** 同じシアター・同じ日の上映と時間が重なるか（終了後の入れ替え時間を含む）。未割り当ての回は判定対象外 */
export function findConflict(candidate: Candidate, showtimes: Showtime[], films: AdminFilm[]): Showtime | null {
  if (candidate.screenId === null) return null;
  const len = (filmId: string) => films.find((f) => f.id === filmId)?.minutes ?? 0;
  const s = toMinutes(candidate.start);
  const e = s + len(candidate.filmId) + TURNOVER_MINUTES;
  return (
    showtimes.find((o) => {
      if (o.id === candidate.id || o.date !== candidate.date || o.screenId !== candidate.screenId) return false;
      const os = toMinutes(o.start);
      const oe = os + len(o.filmId) + TURNOVER_MINUTES;
      return s < oe && os < e;
    }) ?? null
  );
}

export const screenName = (id: string | null) => (id === null ? "未割り当て" : SCREENS.find((s) => s.id === id)?.name ?? "不明なシアター");

/** 重なりの原因をスタッフ向けの文章にする（重なりがなければ null） */
export function describeConflict(candidate: Candidate, showtimes: Showtime[], films: AdminFilm[]): string | null {
  const clash = findConflict(candidate, showtimes, films);
  if (!clash) return null;
  const f = films.find((x) => x.id === clash.filmId);
  const end = f ? fromMinutes(toMinutes(clash.start) + f.minutes) : "--:--";
  return `${screenName(clash.screenId)}の「${f?.name ?? "不明な作品"}」（${clash.start}〜${end}、入れ替え${TURNOVER_MINUTES}分）と重なります。`;
}

/**
 * 既存データ内の重なりを一覧にする（作品の上映時間を延ばした場合などに発生しうる）。
 * 重なった上映回は削除せず、原因を表示してスタッフに判断を委ねる
 */
export function listConflicts(showtimes: Showtime[], films: AdminFilm[]): Map<string, string> {
  const result = new Map<string, string>();
  for (const s of showtimes) {
    const reason = describeConflict(s, showtimes, films);
    if (reason) result.set(s.id, reason);
  }
  return result;
}

/** 上映回をシアターへ割り当てる。重なる場合は変更せず原因を返す */
export function assignScreen(
  showtimes: Showtime[], id: string, screenId: string, films: AdminFilm[],
): { ok: true; showtimes: Showtime[] } | { ok: false; reason: string } {
  const target = showtimes.find((s) => s.id === id);
  if (!target) return { ok: false, reason: "上映回が見つかりません。" };
  const reason = describeConflict({ ...target, screenId }, showtimes, films);
  if (reason) return { ok: false, reason };
  return { ok: true, showtimes: showtimes.map((s) => (s.id === id ? { ...s, screenId } : s)) };
}

/* ───────── 一括登録（旧管理画面の操作を再利用。メモリ上のみ） ───────── */

export const BATCH_LIMITS = { maxDays: 31, maxTimes: 10, maxRows: 100 } as const;

/** 「1000」「900」「10:00」を「HH:MM」にそろえる（旧管理画面と同じルール） */
export function normalizeTimeText(value: string): string {
  const text = value.trim().normalize("NFKC");
  let h: number;
  let m: number;
  if (/^\d{3,4}$/.test(text)) {
    const padded = text.padStart(4, "0");
    h = Number(padded.slice(0, 2));
    m = Number(padded.slice(2));
  } else if (/^\d{1,2}:\d{2}$/.test(text)) {
    [h, m] = text.split(":").map(Number);
  } else {
    throw new Error(`時刻「${value.trim()}」は1000または10:00の形式で入力してください。`);
  }
  if (h > 23 || m > 59) throw new Error(`時刻「${value.trim()}」が正しくありません。`);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** カンマ・読点・空白区切りの開始時刻を正規化し、重複を除いて昇順に並べる */
export function parseStartTimes(input: string): string[] {
  const parts = input.split(/[,、，\s]+/).filter((x) => x.trim());
  return [...new Set(parts.map(normalizeTimeText))].sort();
}

export interface BatchInput {
  filmId: string;
  screenId: string;
  dateFrom: string; // YYYY-MM-DD
  dateTo: string;
  times: string[]; // 正規化済み HH:MM
}

export interface BatchRow {
  key: string;
  filmId: string;
  screenId: string;
  date: string;
  start: string;
  /** 既存の上映回・今回の登録内容と重なる場合の原因（重ならなければ null） */
  conflict: string | null;
}

const dayDiff = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
const addDaysIso = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

/** 入力を検証し、登録予定の行を作る（重なり判定は previewBatch で行う） */
export function buildBatchRows(input: BatchInput, films: AdminFilm[], minDate: string, maxDate: string): Omit<BatchRow, "conflict">[] {
  const film = films.find((f) => f.id === input.filmId);
  if (!film) throw new Error("作品を選択してください。");
  if (film.status === "archived") throw new Error("上映終了の作品は登録できません。");
  if (!SCREENS.some((s) => s.id === input.screenId)) throw new Error("シアターを選択してください。");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.dateFrom) || !/^\d{4}-\d{2}-\d{2}$/.test(input.dateTo)) throw new Error("開始日と終了日を入力してください。");
  if (input.dateTo < input.dateFrom) throw new Error("終了日は開始日以降にしてください。");
  if (input.dateFrom < minDate || input.dateTo > maxDate) throw new Error(`期間は${minDate}〜${maxDate}の範囲で指定してください。`);
  const days = dayDiff(input.dateFrom, input.dateTo) + 1;
  if (days > BATCH_LIMITS.maxDays) throw new Error(`期間は${BATCH_LIMITS.maxDays}日以内で指定してください。`);
  if (input.times.length === 0) throw new Error("上映開始時刻を1件以上入力してください。");
  if (input.times.length > BATCH_LIMITS.maxTimes) throw new Error(`上映開始時刻は${BATCH_LIMITS.maxTimes}件までです。`);
  if (days * input.times.length > BATCH_LIMITS.maxRows) throw new Error(`一度に登録できる上映回は${BATCH_LIMITS.maxRows}件までです。`);
  const rows: Omit<BatchRow, "conflict">[] = [];
  for (let i = 0; i < days; i++) {
    const date = addDaysIso(input.dateFrom, i);
    for (const start of input.times) {
      rows.push({ key: `${date}-${start}`, filmId: input.filmId, screenId: input.screenId, date, start });
    }
  }
  return rows;
}

/** 各行について、既存の上映回と今回の登録内容どうしの重なりを調べる */
export function previewBatch(rows: Omit<BatchRow, "conflict">[], showtimes: Showtime[], films: AdminFilm[]): BatchRow[] {
  const pending: Showtime[] = rows.map((r) => ({ ...r, id: `batch:${r.key}`, status: "draft" }));
  return rows.map((r, i) => {
    const existing = describeConflict(r, showtimes, films);
    if (existing) return { ...r, conflict: existing };
    const others = pending.filter((_, j) => j !== i);
    const clash = findConflict(r, others, films);
    if (!clash) return { ...r, conflict: null };
    const f = films.find((x) => x.id === clash.filmId);
    const end = f ? fromMinutes(toMinutes(clash.start) + f.minutes) : "--:--";
    return { ...r, conflict: `今回の登録内容の${clash.date.slice(5).replace("-", "/")} ${clash.start}〜${end}の回（入れ替え${TURNOVER_MINUTES}分）と重なります。` };
  });
}

/** 1件でも重なりがあれば何も変えずに拒否し、なければ全件を下書きとして追加する */
export function applyBatch(
  rows: BatchRow[], showtimes: Showtime[], films: AdminFilm[], makeId: () => string,
): { ok: true; showtimes: Showtime[]; added: number } | { ok: false; conflicts: number } {
  const checked = previewBatch(rows, showtimes, films); // 確認後に状況が変わっていても再判定する
  const conflicts = checked.filter((r) => r.conflict).length;
  if (conflicts > 0 || rows.length === 0) return { ok: false, conflicts };
  const added: Showtime[] = rows.map((r) => ({ id: makeId(), filmId: r.filmId, screenId: r.screenId, date: r.date, start: r.start, status: "draft" }));
  return { ok: true, showtimes: [...showtimes, ...added], added: added.length };
}
