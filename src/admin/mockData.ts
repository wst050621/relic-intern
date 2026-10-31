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

export interface Showtime {
  id: string;
  filmId: string;
  /** null = 未割り当て（シアター未定）。上映回そのものは保持する */
  screenId: string | null;
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
      list.push({ ...base, id: `${it.filmId}-${day}-${it.start}`, screenId: screen?.id ?? null });
    }
  }
  return list;
}

export const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};
export const fromMinutes = (n: number) => `${String(Math.floor(n / 60) % 24).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;

type Candidate = Omit<Showtime, "id"> & { id?: string };

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
