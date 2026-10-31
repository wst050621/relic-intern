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
  screenId: string;
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
 * 既存の架空上映時刻を、重ならないようにスクリーンへ割り当てる。
 * 既存データはスクリーンを想定しておらず同時刻帯が多いため、3スクリーンに収まらない回はモックでは除外する
 */
export function initialShowtimes(films: AdminFilm[] = initialFilms()): Showtime[] {
  const list: Showtime[] = [];
  for (let day = 0; day < DAYS; day++) {
    const items = FILMS.flatMap((f) => timesFor(f, day).map((start) => ({ filmId: f.id, start })))
      .sort((a, b) => toMinutes(a.start) - toMinutes(b.start));
    for (const it of items) {
      const base = { filmId: it.filmId, date: isoDate(day), start: it.start };
      const screen = SCREENS.find((sc) => !findConflict({ ...base, screenId: sc.id }, list, films));
      if (screen) list.push({ ...base, id: `${it.filmId}-${day}-${it.start}`, screenId: screen.id });
    }
  }
  return list;
}

export const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};
export const fromMinutes = (n: number) => `${String(Math.floor(n / 60) % 24).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;

/** 同じスクリーン・同じ日の上映と時間が重なるか（終了後の入れ替え時間を含む） */
export function findConflict(candidate: Omit<Showtime, "id"> & { id?: string }, showtimes: Showtime[], films: AdminFilm[]): Showtime | null {
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
