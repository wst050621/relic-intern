import { describe, expect, it } from "vitest";
import { DAYS, FILMS, timesFor } from "../shared/films";
import {
  assignScreen, describeConflict, findConflict, initialFilms, initialShowtimes, isoDate, listConflicts, type Showtime,
} from "../src/admin/mockData";
import * as mock from "../src/admin/mockData";

const films = initialFilms();
const key = (s: { filmId: string; date: string; start: string }) => `${s.filmId}|${s.date}|${s.start}`;

describe("管理画面モック：上映回の保持", () => {
  it("既存の架空上映回をすべて保持する（除外しない）", () => {
    const source = new Set<string>();
    for (let day = 0; day < DAYS; day++) {
      for (const f of FILMS) for (const start of timesFor(f, day)) source.add(key({ filmId: f.id, date: isoDate(day), start }));
    }
    const shows = initialShowtimes(films);
    expect(shows.length).toBe(source.size);
    expect(new Set(shows.map(key))).toEqual(source);
  });

  it("割り当て済みの回同士は重ならず、割り当てられない回は未割り当て（null）になる", () => {
    const shows = initialShowtimes(films);
    expect(listConflicts(shows, films).size).toBe(0);
    const unassigned = shows.filter((s) => s.screenId === null);
    expect(unassigned.length).toBeGreaterThan(0);
    // 未割り当ての回は、どのシアターに入れても重なるため割り当てられなかったもの
    for (const s of unassigned) {
      for (const screenId of ["s1", "s2", "s3"]) expect(findConflict({ ...s, screenId }, shows, films)).not.toBeNull();
    }
  });

  it("未割り当ての回は重なり判定の対象外", () => {
    const shows = initialShowtimes(films);
    const u = shows.find((s) => s.screenId === null)!;
    expect(findConflict(u, shows, films)).toBeNull();
  });
});

describe("管理画面モック：シアターの割り当て", () => {
  const base: Showtime[] = [
    { id: "a", filmId: "kitchen", screenId: "s1", status: "confirmed", date: "2026-11-01", start: "10:00" }, // 95分 → 11:35、入れ替え後 11:50
    { id: "b", filmId: "paper", screenId: null, status: "confirmed", date: "2026-11-01", start: "11:00" },
  ];

  it("重なる場合は割り当てず、原因（相手の作品・時刻・入れ替え時間）を返す", () => {
    const r = assignScreen(base, "b", "s1", films);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("シアター1の「七色のキッチン」（10:00〜11:35、入れ替え15分）と重なります。");
  });

  it("空いているシアターには割り当てられ、他の回は変わらない", () => {
    const r = assignScreen(base, "b", "s2", films);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.showtimes.find((s) => s.id === "b")!.screenId).toBe("s2");
      expect(r.showtimes.find((s) => s.id === "a")).toEqual(base[0]);
      expect(r.showtimes.length).toBe(base.length);
    }
  });

  it("入れ替え15分を空ければ同じシアターに割り当てられる", () => {
    const shows: Showtime[] = [base[0], { ...base[1], start: "11:50" }];
    expect(assignScreen(shows, "b", "s1", films).ok).toBe(true);
    expect(assignScreen([base[0], { ...base[1], start: "11:45" }], "b", "s1", films).ok).toBe(false);
  });

  it("既存データの重なり（作品の上映時間を延ばした場合など）は削除せず原因を一覧にする", () => {
    const shows: Showtime[] = [
      { id: "x", filmId: "kitchen", screenId: "s1", status: "confirmed", date: "2026-11-01", start: "10:00" },
      { id: "y", filmId: "paper", screenId: "s1", status: "confirmed", date: "2026-11-01", start: "12:00" },
    ];
    expect(listConflicts(shows, films).size).toBe(0);
    const longer = films.map((f) => (f.id === "kitchen" ? { ...f, minutes: 120 } : f));
    const conflicts = listConflicts(shows, longer);
    expect([...conflicts.keys()].sort()).toEqual(["x", "y"]);
    expect(conflicts.get("y")).toContain("七色のキッチン");
    expect(describeConflict(shows[0], shows, longer)).toContain("月と紙飛行機");
    expect(shows.length).toBe(2);
  });
});

describe("管理画面モック：一括登録", () => {
  const { normalizeTimeText, parseStartTimes, buildBatchRows, previewBatch, applyBatch, BATCH_LIMITS } = mock;
  const MIN = "2026-11-01";
  const MAX = "2026-12-31";
  let seq = 0;
  const makeId = () => `new-${++seq}`;
  const input = (over: Partial<import("../src/admin/mockData").BatchInput> = {}) =>
    ({ filmId: "kitchen", screenId: "s2", dateFrom: "2026-11-02", dateTo: "2026-11-03", times: ["10:00", "13:30"], ...over });

  it("開始時刻を正規化し、重複を除いて昇順に並べる（旧管理画面のルール）", () => {
    expect(normalizeTimeText("1000")).toBe("10:00");
    expect(normalizeTimeText("900")).toBe("09:00");
    expect(normalizeTimeText("９:０５")).toBe("09:05");
    expect(parseStartTimes("1830, 1000、13:30 1000")).toEqual(["10:00", "13:30", "18:30"]);
    expect(() => normalizeTimeText("2560")).toThrow("正しくありません");
    expect(() => normalizeTimeText("10時")).toThrow("1000または10:00");
  });

  it("期間 × 開始時刻の行を作り、入力の誤りと上限を検査する", () => {
    expect(buildBatchRows(input(), films, MIN, MAX).map((r) => `${r.date} ${r.start}`)).toEqual([
      "2026-11-02 10:00", "2026-11-02 13:30", "2026-11-03 10:00", "2026-11-03 13:30",
    ]);
    expect(() => buildBatchRows(input({ filmId: "" }), films, MIN, MAX)).toThrow("作品");
    expect(() => buildBatchRows(input({ dateTo: "2026-11-01", dateFrom: "2026-11-02" }), films, MIN, MAX)).toThrow("終了日は開始日以降");
    expect(() => buildBatchRows(input({ dateFrom: "2026-10-31" }), films, MIN, MAX)).toThrow("範囲");
    expect(() => buildBatchRows(input({ times: [] }), films, MIN, MAX)).toThrow("1件以上");
    expect(() => buildBatchRows(input({ times: Array.from({ length: 11 }, (_, i) => `${String(i + 8).padStart(2, "0")}:00`) }), films, MIN, MAX)).toThrow("10件まで");
    expect(() => buildBatchRows(input({ dateFrom: "2026-11-01", dateTo: "2026-12-02" }), films, MIN, MAX)).toThrow(`${BATCH_LIMITS.maxDays}日以内`);
    // 31日 × 4回 = 124件 > 100件
    expect(() => buildBatchRows(input({ dateFrom: "2026-11-01", dateTo: "2026-12-01", times: ["09:00", "12:00", "15:00", "18:00"] }), films, MIN, MAX)).toThrow("100件まで");
    const archived = films.map((f) => (f.id === "kitchen" ? { ...f, status: "archived" as const } : f));
    expect(() => buildBatchRows(input(), archived, MIN, MAX)).toThrow("上映終了");
  });

  it("正常系：重なりがなければ全件を下書きとして追加し、既存の上映回は変わらない", () => {
    const existing: Showtime[] = [{ id: "e1", filmId: "paper", screenId: "s2", status: "confirmed", date: "2026-11-02", start: "16:00" }];
    const rows = previewBatch(buildBatchRows(input(), films, MIN, MAX), existing, films);
    expect(rows.every((r) => r.conflict === null)).toBe(true);
    const r = applyBatch(rows, existing, films, makeId);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.added).toBe(4);
      expect(r.showtimes.length).toBe(5);
      expect(r.showtimes[0]).toEqual(existing[0]);
      expect(r.showtimes.slice(1).every((s) => s.status === "draft" && s.screenId === "s2")).toBe(true);
    }
  });

  it("既存の上映回と重なれば原因を表示し、1件も登録しない（既存も削除しない）", () => {
    // 既存：七色のキッチン 12:30〜14:05（+15分）→ 13:30 の回が重なる
    const existing: Showtime[] = [{ id: "e1", filmId: "kitchen", screenId: "s2", status: "confirmed", date: "2026-11-03", start: "12:30" }];
    const rows = previewBatch(buildBatchRows(input(), films, MIN, MAX), existing, films);
    const conflicts = rows.filter((r) => r.conflict);
    expect(conflicts.map((r) => `${r.date} ${r.start}`)).toEqual(["2026-11-03 13:30"]);
    expect(conflicts[0].conflict).toBe("シアター2の「七色のキッチン」（12:30〜14:05、入れ替え15分）と重なります。");
    const r = applyBatch(rows, existing, films, makeId);
    expect(r).toEqual({ ok: false, conflicts: 1 });
    expect(existing).toEqual([{ id: "e1", filmId: "kitchen", screenId: "s2", status: "confirmed", date: "2026-11-03", start: "12:30" }]);
  });

  it("今回の登録内容どうしの重なりも検出して全件拒否する", () => {
    // 最後の星図（124分）を 10:00 と 11:00 → 互いに重なる
    const rows = previewBatch(buildBatchRows(input({ filmId: "star", times: ["10:00", "11:00"], dateTo: "2026-11-02" }), films, MIN, MAX), [], films);
    expect(rows.filter((r) => r.conflict).length).toBe(2);
    expect(rows[0].conflict).toContain("今回の登録内容");
    expect(applyBatch(rows, [], films, makeId)).toEqual({ ok: false, conflicts: 2 });
  });

  it("確認後に他の上映回が追加されて重なった場合も、登録時に再判定して拒否する", () => {
    const rows = previewBatch(buildBatchRows(input(), films, MIN, MAX), [], films);
    expect(rows.every((r) => !r.conflict)).toBe(true);
    const later: Showtime[] = [{ id: "x", filmId: "paper", screenId: "s2", status: "draft", date: "2026-11-02", start: "09:00" }];
    expect(applyBatch(rows, later, films, makeId)).toEqual({ ok: false, conflicts: 1 });
  });
});

describe("管理画面モック：週の移動", () => {
  const { weekDays, weekOffsetOf, batchRange } = mock;
  const base = new Date(2026, 9, 31); // 2026-10-31（ローカル日付）

  it("前週・今週・翌週の7日間を返す", () => {
    expect(weekDays(0, base)).toEqual(["2026-10-31", "2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06"]);
    expect(weekDays(1, base)[0]).toBe("2026-11-07");
    expect(weekDays(-1, base)).toEqual(["2026-10-24", "2026-10-25", "2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30"]);
  });

  it("日付が入る週を求める（未割り当ての日付から週へ移動するため）", () => {
    expect(weekOffsetOf("2026-10-31", base)).toBe(0);
    expect(weekOffsetOf("2026-11-06", base)).toBe(0);
    expect(weekOffsetOf("2026-11-07", base)).toBe(1);
    expect(weekOffsetOf("2026-10-30", base)).toBe(-1);
  });

  it("一括登録の期間は表示中の週に連動し、過去の日付は選べない", () => {
    expect(batchRange(weekDays(1, base), "2026-10-31")).toEqual({ min: "2026-11-07", max: "2026-11-13" });
    expect(batchRange(weekDays(0, base), "2026-11-02")).toEqual({ min: "2026-11-02", max: "2026-11-06" });
    expect(batchRange(weekDays(-1, base), "2026-10-31")).toBeNull();
  });

  it("週を移動しても上映回のデータは変わらない（表示は絞り込みだけ）", () => {
    const all = initialShowtimes(films);
    const snapshot = JSON.stringify(all);
    const inWeek = (w: string[]) => all.filter((s) => w.includes(s.date)).length;
    expect(inWeek(weekDays(0)) + inWeek(weekDays(1)) + inWeek(weekDays(-1))).toBe(all.length);
    expect(JSON.stringify(all)).toBe(snapshot);
  });
});
