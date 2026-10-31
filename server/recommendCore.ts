import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import { DAYS, GENRES, MOODS } from "../shared/films.js";
import {
  EMPTY_CONDITIONS, MAX_MESSAGE_LENGTH, localParse, recommend, sanitizeConditions,
  type Conditions, type Recommendation,
} from "../shared/recommend.js";

export type Source = "gemini" | "local";

export interface RecommendResponse {
  source: Source;
  notice?: string;
  conditions: Conditions;
  recommendations: Recommendation[];
}

export interface CoreResult {
  status: number;
  body: RecommendResponse | { error: string };
}

export type GeminiCaller = (message: string, todayInfo: string) => Promise<unknown>;

// GEMINI_MODEL（Vercel環境変数）が優先。未設定時の既定値
export const DEFAULT_MODEL = "gemini-3.6-flash";

export function resolveModel(env: { GEMINI_MODEL?: string }): string {
  return env.GEMINI_MODEL?.trim() || DEFAULT_MODEL;
}
const TIMEOUT_MS = 8000;

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    genre: { type: ["string", "null"], enum: [...GENRES, null] },
    mood: { type: ["string", "null"], enum: [...MOODS, null] },
    maxMinutes: { type: ["integer", "null"] },
    dayOffset: { type: "integer", minimum: 0, maximum: DAYS - 1 },
  },
  required: ["genre", "mood", "maxMinutes", "dayOffset"],
};

const SYSTEM_INSTRUCTION = [
  "あなたは映画館の検索フォームへの入力正規化器です。",
  "利用者の日本語の相談文を、検索条件JSONへ変換するだけを行います。",
  "作品名・上映時刻・あらすじなどを新たに創作・推測してはいけません。JSON以外を出力してはいけません。",
  `genre は次のいずれか、該当なしなら null: ${GENRES.join(" / ")}`,
  `mood は次のいずれか、該当なしなら null: ${MOODS.join(" / ")}（例: 泣ける→感動したい、笑える→笑いたい、怖い・ハラハラ→ドキドキしたい）`,
  "maxMinutes は上映時間の上限（分）。「2時間以内」は120、指定がなければ null。",
  `dayOffset は今日を0とした鑑賞日の日数（0〜${DAYS - 1}）。明日=1、明後日=2。曜日指定は下記の日付表から求め、範囲外・指定なしは既定値を使う。`,
].join("\n");

export function todayInfo(now = new Date(), defaultDay = 0): string {
  const fmt = new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", weekday: "short" });
  const rows = Array.from({ length: DAYS }, (_, i) => `${i}: ${fmt.format(new Date(now.getTime() + i * 86400000))}`);
  return `日付表（Asia/Tokyo）\n${rows.join("\n")}\n既定の dayOffset: ${defaultDay}`;
}

export function createGeminiCaller(apiKey: string, model: string): GeminiCaller {
  const ai = new GoogleGenAI({ apiKey });
  return async (message, info) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await ai.models.generateContent({
        model,
        contents: `${info}\n\n相談文:\n${message}`,
        config: {
          systemInstruction: SYSTEM_INSTRUCTION,
          responseMimeType: "application/json",
          responseJsonSchema: RESPONSE_SCHEMA,
          // Gemini 3系は temperature を既定のままにする。単純な正規化なので思考量は抑えて応答時間を短くする
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
          abortSignal: controller.signal,
          httpOptions: { timeout: TIMEOUT_MS },
        },
      });
      return JSON.parse(res.text ?? "null");
    } finally {
      clearTimeout(timer);
    }
  };
}

function errorStatus(err: unknown): number | undefined {
  const s = (err as { status?: unknown })?.status;
  return typeof s === "number" ? s : undefined;
}

/** HTTPに依存しないAPI本体。キーや内部エラー詳細はレスポンスに含めない */
export async function handleRecommend(
  input: { method?: string; contentType?: string; body: unknown },
  env: { GEMINI_API_KEY?: string; GEMINI_MODEL?: string },
  deps: { callGemini?: GeminiCaller; log?: (msg: string) => void } = {},
): Promise<CoreResult> {
  if (input.method !== "POST") return { status: 405, body: { error: "POST のみ利用できます。" } };
  if (!input.contentType?.toLowerCase().includes("application/json")) {
    return { status: 415, body: { error: "Content-Type は application/json にしてください。" } };
  }
  const body = (typeof input.body === "object" && input.body !== null ? input.body : {}) as Record<string, unknown>;
  const message = typeof body.message === "string" ? body.message.trim() : "";
  const defaultDay = sanitizeConditions({ dayOffset: body.dayOffset }).dayOffset;
  if (!message) return { status: 400, body: { error: "相談文を入力してください。" } };
  if ([...message].length > MAX_MESSAGE_LENGTH) {
    return { status: 400, body: { error: `相談文は${MAX_MESSAGE_LENGTH}字以内で入力してください。` } };
  }

  const local = (notice: string): CoreResult => {
    const conditions = localParse(message, defaultDay);
    return { status: 200, body: { source: "local", notice, conditions, recommendations: recommend(conditions) } };
  };

  const caller = deps.callGemini ?? (env.GEMINI_API_KEY ? createGeminiCaller(env.GEMINI_API_KEY, resolveModel(env)) : null);
  if (!caller) return local("AI解析は現在利用できません（設定未完了）。キーワードから条件を推定しました。");

  try {
    const raw = await caller(message, todayInfo(new Date(), defaultDay));
    const conditions = raw && typeof raw === "object" ? sanitizeConditions(raw, defaultDay) : { ...EMPTY_CONDITIONS, dayOffset: defaultDay };
    return { status: 200, body: { source: "gemini", conditions, recommendations: recommend(conditions) } };
  } catch (err) {
    const status = errorStatus(err);
    deps.log?.(`gemini_failed status=${status ?? "n/a"} name=${(err as Error)?.name ?? "unknown"}`);
    if (status === 429) return local("AIの利用が混み合っています。キーワードから条件を推定しました。");
    return local("AI解析に失敗しました。キーワードから条件を推定しました。");
  }
}
