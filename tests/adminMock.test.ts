import { describe, expect, it } from "vitest";
import { DAYS, FILMS, timesFor } from "../shared/films";
import {
  assignScreen, describeConflict, findConflict, initialFilms, initialShowtimes, isoDate, listConflicts, type Showtime,
} from "../src/admin/mockData";

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
    { id: "a", filmId: "kitchen", screenId: "s1", date: "2026-11-01", start: "10:00" }, // 95分 → 11:35、入れ替え後 11:50
    { id: "b", filmId: "paper", screenId: null, date: "2026-11-01", start: "11:00" },
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
      { id: "x", filmId: "kitchen", screenId: "s1", date: "2026-11-01", start: "10:00" },
      { id: "y", filmId: "paper", screenId: "s1", date: "2026-11-01", start: "12:00" },
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
