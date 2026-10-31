import { z } from "zod";
import { DAYS, FILMS, GENRES, MOODS, timesFor, type Film, type Genre, type Mood } from "./films.js";

export const MAX_MESSAGE_LENGTH = 300;

export interface Conditions {
  genre: Genre | null;
  mood: Mood | null;
  maxMinutes: number | null;
  dayOffset: number;
}

export const EMPTY_CONDITIONS: Conditions = { genre: null, mood: null, maxMinutes: null, dayOffset: 0 };

export interface Recommendation {
  id: string;
  score: number;
  reason: string;
  times: string[];
}

/** Gemini出力（または任意の入力）を検証・補正する。想定外の値は null / 範囲内へ丸める */
const looseSchema = z.object({
  genre: z.unknown().optional(),
  mood: z.unknown().optional(),
  maxMinutes: z.unknown().optional(),
  dayOffset: z.unknown().optional(),
});

export function sanitizeConditions(raw: unknown, fallbackDay = 0): Conditions {
  const parsed = looseSchema.safeParse(raw);
  const v = parsed.success ? parsed.data : {};
  const genre = (GENRES as readonly unknown[]).includes(v.genre) ? (v.genre as Genre) : null;
  const mood = (MOODS as readonly unknown[]).includes(v.mood) ? (v.mood as Mood) : null;
  let maxMinutes: number | null = null;
  if (typeof v.maxMinutes === "number" && Number.isFinite(v.maxMinutes) && v.maxMinutes > 0) {
    maxMinutes = Math.min(240, Math.max(60, Math.round(v.maxMinutes)));
  }
  let dayOffset = clampDay(fallbackDay);
  if (typeof v.dayOffset === "number" && Number.isFinite(v.dayOffset)) dayOffset = clampDay(v.dayOffset);
  return { genre, mood, maxMinutes, dayOffset };
}

function clampDay(n: number): number {
  return Math.min(DAYS - 1, Math.max(0, Math.round(n)));
}

/** Gemini不使用時のローカル簡易解釈（キーワード一致） */
const GENRE_WORDS: Record<Genre, string[]> = {
  ドラマ: ["ドラマ", "人間"], アニメ: ["アニメ"], SF: ["SF", "ＳＦ", "宇宙", "未来"], サスペンス: ["サスペンス", "ミステリー", "謎"],
  コメディ: ["コメディ", "喜劇"], 恋愛: ["恋愛", "ラブ", "恋"], ホラー: ["ホラー", "怖", "こわ"], 音楽: ["音楽", "ミュージック"], ファンタジー: ["ファンタジー", "魔法"],
};
const MOOD_WORDS: Record<Mood, string[]> = {
  感動したい: ["泣", "感動"], 笑いたい: ["笑", "面白", "おもしろ", "楽しい"], ドキドキしたい: ["ドキドキ", "ハラハラ", "スリル"],
  ほっこりしたい: ["ほっこり", "癒", "温か", "あたたか"], じっくり観たい: ["じっくり", "考え"], 家族で楽しむ: ["家族", "子ども", "子供", "親子"],
};

export function localParse(message: string, fallbackDay = 0): Conditions {
  const text = message.normalize("NFKC");
  const find = <K extends string>(dict: Record<K, string[]>): K | null =>
    (Object.keys(dict) as K[]).find((k) => dict[k].some((w) => text.includes(w.normalize("NFKC")))) ?? null;
  const minutes = text.match(/(\d{2,3})\s*分/);
  let dayOffset = fallbackDay;
  if (text.includes("明後日") || text.includes("あさって")) dayOffset = 2;
  else if (text.includes("明日") || text.includes("あした")) dayOffset = 1;
  else if (text.includes("今日") || text.includes("今夜")) dayOffset = 0;
  return sanitizeConditions(
    { genre: find(GENRE_WORDS), mood: find(MOOD_WORDS), maxMinutes: minutes ? Number(minutes[1]) : null, dayOffset },
    fallbackDay,
  );
}

export function scoreFilm(film: Film, c: Conditions): number | null {
  if (c.maxMinutes !== null && film.minutes > c.maxMinutes) return null;
  const genreOK = c.genre !== null && film.genre.includes(c.genre);
  const moodOK = c.mood !== null && film.mood.includes(c.mood);
  if (c.genre !== null && !genreOK && c.mood !== null && !moodOK) return null;
  return Math.min(99, 65 + (genreOK ? 22 : 0) + (moodOK ? 12 : 0) + (c.maxMinutes !== null ? 3 : 0));
}

export function reasonFor(film: Film, c: Conditions): string {
  const parts: string[] = [];
  if (c.genre && film.genre.includes(c.genre)) parts.push(`${c.genre}の作品`);
  if (c.mood && film.mood.includes(c.mood)) parts.push(`「${c.mood}」気分にぴったり`);
  if (c.maxMinutes !== null) parts.push(`${film.minutes}分で${c.maxMinutes}分以内に収まります`);
  if (!parts.length) parts.push(`${film.genre.join("・")}を楽しめる作品`);
  return parts.join("・") + "。";
}

/** 上映予定のある登録作品だけを対象に決定的にランキングする */
export function rankFilms(c: Conditions, limit: number | null = 3): Array<Recommendation & { film: Film }> {
  const ranked = FILMS.map((film) => ({ film, times: timesFor(film, c.dayOffset), score: scoreFilm(film, c) }))
    .filter((x): x is { film: Film; times: string[]; score: number } => x.times.length > 0 && x.score !== null)
    .sort((a, b) => b.score - a.score || a.film.minutes - b.film.minutes)
    .map((x) => ({ id: x.film.id, film: x.film, score: x.score, times: x.times, reason: reasonFor(x.film, c) }));
  return limit === null ? ranked : ranked.slice(0, limit);
}

export function recommend(c: Conditions): Recommendation[] {
  return rankFilms(c).map(({ id, score, reason, times }) => ({ id, score, reason, times }));
}
