import { afterEach, describe, expect, it, vi } from "vitest";
import { FILMS, timesFor } from "../shared/films";
import { localParse, recommend, sanitizeConditions } from "../shared/recommend";
import { DEFAULT_MODEL, RESPONSE_SCHEMA, TIMEOUT_MS, createGeminiCaller, UNSPECIFIED, describeGeminiError, handleRecommend, resolveModel } from "../server/recommendCore";

const ids = new Set(FILMS.map((f) => f.id));
const post = (body: unknown) => ({ method: "POST", contentType: "application/json", body });

describe("推薦ロジック", () => {
  it("100分以内で笑える → 100分超を含まず最大3件、登録作品のみ", () => {
    const recs = recommend({ genre: null, mood: "笑いたい", maxMinutes: 100, dayOffset: 0 });
    expect(recs.length).toBeGreaterThan(0);
    expect(recs.length).toBeLessThanOrEqual(3);
    for (const r of recs) {
      const film = FILMS.find((f) => f.id === r.id)!;
      expect(film).toBeDefined();
      expect(film.minutes).toBeLessThanOrEqual(100);
    }
    expect(recs[0].id).toBe("kitchen");
  });

  it("上映時刻はローカルの上映予定と一致し、上映のない日は候補外", () => {
    for (let day = 0; day < 7; day++) {
      for (const r of recommend({ genre: null, mood: null, maxMinutes: null, dayOffset: day })) {
        const film = FILMS.find((f) => f.id === r.id)!;
        expect(r.times).toEqual(timesFor(film, day));
        expect(r.times.length).toBeGreaterThan(0);
      }
    }
  });

  it("想定外の値は補正・拒否する", () => {
    expect(sanitizeConditions({ genre: "西部劇", mood: 1, maxMinutes: 9999, dayOffset: 42 })).toEqual({
      genre: null, mood: null, maxMinutes: 240, dayOffset: 6,
    });
    expect(sanitizeConditions("garbage", 2)).toEqual({ genre: null, mood: null, maxMinutes: null, dayOffset: 2 });
  });

  it("ローカル簡易解釈: 明日、ドキドキするSF", () => {
    expect(localParse("明日、ドキドキするSF")).toEqual({ genre: "SF", mood: "ドキドキしたい", maxMinutes: null, dayOffset: 1 });
  });
});

describe("POST /api/recommend 本体", () => {
  it("Gemini成功時: 解釈を補正して登録作品のみ返す（作品の創作を無視）", async () => {
    const res = await handleRecommend(post({ message: "明日、ドキドキするSF", dayOffset: 0 }), { GEMINI_API_KEY: "x" }, {
      callGemini: async () => ({ genre: "SF", mood: "ドキドキしたい", maxMinutes: null, dayOffset: 1, title: "架空の新作", times: ["25:00"] }),
    });
    expect(res.status).toBe(200);
    const body = res.body as any;
    expect(body.source).toBe("gemini");
    expect(body.conditions).toEqual({ genre: "SF", mood: "ドキドキしたい", maxMinutes: null, dayOffset: 1 });
    expect(body.recommendations[0].id).toBe("star");
    for (const r of body.recommendations) expect(ids.has(r.id)).toBe(true);
    expect(JSON.stringify(body)).not.toContain("架空の新作");
  });

  it("キー未設定 → 200でローカル推薦", async () => {
    const res = await handleRecommend(post({ message: "泣ける映画が観たい" }), {});
    expect(res.status).toBe(200);
    expect((res.body as any).source).toBe("local");
    expect((res.body as any).conditions.mood).toBe("感動したい");
  });

  it("429 / タイムアウト → 秘密情報を含まずローカル推薦", async () => {
    for (const err of [Object.assign(new Error("quota key=SECRET123"), { status: 429 }), Object.assign(new Error("SECRET123"), { name: "AbortError" })]) {
      const res = await handleRecommend(post({ message: "笑える映画" }), { GEMINI_API_KEY: "SECRET123" }, {
        callGemini: async () => { throw err; },
      });
      expect(res.status).toBe(200);
      expect((res.body as any).source).toBe("local");
      expect(JSON.stringify(res.body)).not.toContain("SECRET123");
    }
  });

  it("入力検査: メソッド・形式・文字数・空文字", async () => {
    expect((await handleRecommend({ method: "GET", body: null }, {})).status).toBe(405);
    expect((await handleRecommend({ method: "POST", contentType: "text/plain", body: "x" }, {})).status).toBe(415);
    expect((await handleRecommend(post({ message: "あ".repeat(301) }), {})).status).toBe(400);
    expect((await handleRecommend(post({ message: "   " }), {})).status).toBe(400);
    expect((await handleRecommend(post(null), {})).status).toBe(400);
  });

  it("誤字・曖昧文でも落ちない", async () => {
    const res = await handleRecommend(post({ message: "なんか、えいが？？ わらえるやつ" }), {}, {});
    expect(res.status).toBe(200);
  });
});

describe("Geminiモデル設定", () => {
  it("GEMINI_MODEL を優先し、未設定・空なら gemini-3.6-flash", () => {
    expect(DEFAULT_MODEL).toBe("gemini-3.6-flash");
    expect(resolveModel({})).toBe("gemini-3.6-flash");
    expect(resolveModel({ GEMINI_MODEL: "  " })).toBe("gemini-3.6-flash");
    expect(resolveModel({ GEMINI_MODEL: "gemini-3.6-flash" })).toBe("gemini-3.6-flash");
    expect(resolveModel({ GEMINI_MODEL: "other-model" })).toBe("other-model");
  });

  it("「明日、100分以内で笑える映画を観たい」→ 100分超を含まず最大3件、明日の上映のみ", async () => {
    const res = await handleRecommend(post({ message: "明日、100分以内で笑える映画を観たい", dayOffset: 0 }), {});
    const body = res.body as any;
    expect(body.conditions).toEqual({ genre: null, mood: "笑いたい", maxMinutes: 100, dayOffset: 1 });
    expect(body.recommendations.length).toBeLessThanOrEqual(3);
    for (const r of body.recommendations) {
      const film = FILMS.find((f) => f.id === r.id)!;
      expect(film.minutes).toBeLessThanOrEqual(100);
      expect(r.times).toEqual(timesFor(film, 1));
    }
  });
});

describe("Gemini レスポンス形式（responseJsonSchema）", () => {
  // Gemini API の responseJsonSchema が受け付けるキーワード（公式 API 定義より）
  const SUPPORTED = new Set(["$id", "$defs", "$ref", "$anchor", "type", "format", "title", "description", "enum", "items", "prefixItems",
    "minItems", "maxItems", "minimum", "maximum", "anyOf", "oneOf", "properties", "additionalProperties", "required", "propertyOrdering"]);

  function walk(node: any, path: string): string[] {
    const errors: string[] = [];
    for (const [k, v] of Object.entries(node)) {
      if (!SUPPORTED.has(k)) errors.push(`${path}: unsupported keyword ${k}`);
      if (k === "type" && typeof v !== "string") errors.push(`${path}: type must be a single string`);
      if (k === "enum") for (const e of v as unknown[]) if (typeof e !== "string" && typeof e !== "number") errors.push(`${path}: enum value ${String(e)}`);
    }
    for (const [k, child] of Object.entries(node.properties ?? {})) errors.push(...walk(child, `${path}.${k}`));
    return errors;
  }

  it("サポート対象のキーワードのみ・enum は文字列/数値のみ・null を含まない", () => {
    expect(walk(RESPONSE_SCHEMA, "$")).toEqual([]);
  });

  it("「指定なし」・maxMinutes=0 は null に補正される", async () => {
    const res = await handleRecommend(post({ message: "何か観たい" }), { GEMINI_API_KEY: "x" }, {
      callGemini: async () => ({ genre: UNSPECIFIED, mood: UNSPECIFIED, maxMinutes: 0, dayOffset: 0 }),
    });
    expect((res.body as any).source).toBe("gemini");
    expect((res.body as any).conditions).toEqual({ genre: null, mood: null, maxMinutes: null, dayOffset: 0 });
  });

  it("スキーマ準拠の Gemini 出力「明日、100分以内で笑える映画を観たい」", async () => {
    const res = await handleRecommend(post({ message: "明日、100分以内で笑える映画を観たい" }), { GEMINI_API_KEY: "x" }, {
      callGemini: async () => ({ genre: UNSPECIFIED, mood: "笑いたい", maxMinutes: 100, dayOffset: 1 }),
    });
    const body = res.body as any;
    expect(body.source).toBe("gemini");
    expect(body.recommendations[0].id).toBe("kitchen");
    for (const r of body.recommendations) expect(FILMS.find((f) => f.id === r.id)!.minutes).toBeLessThanOrEqual(100);
  });
});

describe("Gemini エラーのログ要約", () => {
  const apiErr = (reason: string, message: string) =>
    Object.assign(new Error(JSON.stringify({ error: { code: 400, message, status: "INVALID_ARGUMENT", details: [{ reason }] } })), { name: "ApiError", status: 400 });

  it("API_KEY_INVALID を区別でき、キーは伏せられる", () => {
    const line = describeGeminiError(apiErr("API_KEY_INVALID", "API key not valid. key=MYSECRETKEY AIzaSyDUMMYDUMMYDUMMY"), "MYSECRETKEY");
    expect(line).toContain("status=400");
    expect(line).toContain("reason=API_KEY_INVALID");
    expect(line).not.toContain("MYSECRETKEY");
    expect(line).not.toContain("AIzaSyDUMMY");
  });

  it("リクエスト形式エラーはメッセージで区別できる", () => {
    const err = Object.assign(new Error(JSON.stringify({ error: { code: 400, message: "Invalid value at 'generation_config'", status: "INVALID_ARGUMENT" } })), { name: "ApiError", status: 400 });
    expect(describeGeminiError(err)).toContain("reason=INVALID_ARGUMENT detail=\"Invalid value at 'generation_config'\"");
  });

  it("ログに出しても公開レスポンスには詳細を返さない／キーの前後空白を除去", async () => {
    const logs: string[] = [];
    const res = await handleRecommend(post({ message: "笑える映画" }), { GEMINI_API_KEY: "  MYSECRETKEY\n" }, {
      callGemini: async () => { throw apiErr("API_KEY_INVALID", "API key not valid."); },
      log: (m) => logs.push(m),
    });
    expect(logs[0]).toContain("reason=API_KEY_INVALID");
    expect(JSON.stringify(res.body)).not.toContain("API_KEY_INVALID");
    expect((res.body as any).source).toBe("local");
  });
});

describe("Gemini タイムアウト設定", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("SDK が送る deadline は Gemini API の下限10秒以上（20秒）", async () => {
    let headers: Headers | null = null;
    vi.stubGlobal("fetch", async (_url: unknown, init: RequestInit) => {
      headers = new Headers(init.headers);
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"genre":"SF","mood":"指定なし","maxMinutes":0,"dayOffset":0}' }] } }] }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    });
    await createGeminiCaller("dummy", DEFAULT_MODEL)("SF", "info");
    expect(TIMEOUT_MS).toBe(20000);
    const deadline = Number(headers!.get("x-server-timeout"));
    expect(deadline).toBeGreaterThanOrEqual(10);
    expect(deadline).toBe(TIMEOUT_MS / 1000);
  });

  it("Gemini の deadline エラー（400）でもローカル推薦へフォールバックし、詳細は返さない", async () => {
    const err = Object.assign(new Error(JSON.stringify({ error: { code: 400, status: "INVALID_ARGUMENT", message: "Manually set deadline 8s is too short. Minimum allowed deadline is 10s." } })), { name: "ApiError", status: 400 });
    const logs: string[] = [];
    const res = await handleRecommend(post({ message: "笑える映画" }), { GEMINI_API_KEY: "MYSECRETKEY" }, {
      callGemini: async () => { throw err; },
      log: (m) => logs.push(m),
    });
    expect((res.body as any).source).toBe("local");
    expect(JSON.stringify(res.body)).not.toContain("deadline");
    expect(logs[0]).toContain("deadline 8s is too short");
    expect(logs[0]).not.toContain("MYSECRETKEY");
  });
});
