// 架空の作品・上映データ（FR-09）。上映事実の唯一の正本。
export const GENRES = ["ドラマ", "アニメ", "SF", "サスペンス", "コメディ", "恋愛", "ホラー", "音楽", "ファンタジー"] as const;
export const MOODS = ["感動したい", "笑いたい", "ドキドキしたい", "ほっこりしたい", "じっくり観たい", "家族で楽しむ"] as const;
export const RUNTIME_OPTIONS = [100, 120, 140] as const;
export const DAYS = 7;

export type Genre = (typeof GENRES)[number];
export type Mood = (typeof MOODS)[number];

export interface Film {
  id: string;
  name: string;
  genre: Genre[];
  mood: Mood[];
  minutes: number;
  director: string;
  synopsis: string;
  theme: string;
  times: string[];
  /** 休映日（今日からの日数オフセット） */
  offDays: number[];
}

export const FILMS: Film[] = [
  { id: "record", name: "夜明けのレコード", genre: ["ドラマ", "音楽"], mood: ["感動したい", "じっくり観たい"], minutes: 112, director: "水野 澪", synopsis: "閉店間近のレコード店で見つかった一枚の音源。街の記憶と家族の秘密をめぐる物語。", theme: "river", times: ["10:20", "15:10", "19:30"], offDays: [3] },
  { id: "paper", name: "月と紙飛行機", genre: ["アニメ", "ファンタジー"], mood: ["ほっこりしたい", "家族で楽しむ"], minutes: 98, director: "南 早紀", synopsis: "空へ届く手紙を作る少女が、月明かりの街で不思議な友だちに出会う。", theme: "paper", times: ["09:40", "13:20", "17:00"], offDays: [1] },
  { id: "star", name: "最後の星図", genre: ["SF", "サスペンス"], mood: ["ドキドキしたい", "じっくり観たい"], minutes: 124, director: "橘 蓮", synopsis: "消えた星を記す古い地図を手がかりに、観測員たちが宇宙の謎へ迫る。", theme: "space", times: ["11:30", "16:45", "20:10"], offDays: [2] },
  { id: "spring", name: "春の駅舎", genre: ["恋愛", "ドラマ"], mood: ["感動したい", "ほっこりしたい"], minutes: 104, director: "青木 春", synopsis: "廃線が決まった駅で再会した二人。最後の春を描く静かなラブストーリー。", theme: "spring", times: ["12:10", "18:00"], offDays: [5] },
  { id: "specimen", name: "真夜中の標本室", genre: ["ホラー", "サスペンス"], mood: ["ドキドキしたい"], minutes: 108, director: "秋山 燈", synopsis: "校舎の古い標本室で起きた不思議な出来事を追う、密室ミステリーホラー。", theme: "night", times: ["17:30", "21:00"], offDays: [4] },
  { id: "kitchen", name: "七色のキッチン", genre: ["コメディ", "ドラマ"], mood: ["笑いたい", "家族で楽しむ", "ほっこりしたい"], minutes: 95, director: "佐伯 美空", synopsis: "小さな食堂に集う人々の一週間。料理と笑顔がつなぐ心温まる群像劇。", theme: "food", times: ["10:50", "14:40", "18:20"], offDays: [6] },
];

/** 架空の上映予定：今日からの日数オフセットごとに決定的に変化させる */
export function timesFor(film: Film, dayOffset: number): string[] {
  if (film.offDays.includes(dayOffset)) return [];
  return film.times.slice(0, dayOffset % 3 === 2 ? 2 : 3);
}
