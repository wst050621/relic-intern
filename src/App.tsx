import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { DAYS, GENRES, MOODS, RUNTIME_OPTIONS, timesFor, type Film } from "../shared/films";
import { EMPTY_CONDITIONS, MAX_MESSAGE_LENGTH, localParse, rankFilms, type Conditions } from "../shared/recommend";

type Status =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "success"; source: "gemini" | "local"; notice?: string }
  | { kind: "error"; message: string };

const EXAMPLES = ["今日は気軽に笑える100分以内の映画", "泣ける映画が観たい", "明日、ドキドキするSF"];
// サーバー側の Gemini タイムアウト（20秒）より長くする
const CLIENT_TIMEOUT_MS = 25000;

function dayAt(offset: number): Date {
  const n = new Date();
  return new Date(n.getFullYear(), n.getMonth(), n.getDate() + offset);
}
const fullDate = (offset: number) =>
  new Intl.DateTimeFormat("ja-JP", { month: "long", day: "numeric", weekday: "short" }).format(dayAt(offset));
const dayLabel = (offset: number) => (offset === 0 ? "今日" : offset === 1 ? "明日" : fullDate(offset));

export default function App() {
  const [message, setMessage] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [conditions, setConditions] = useState<Conditions>(EMPTY_CONDITIONS);
  const [interpreted, setInterpreted] = useState<Conditions | null>(null);
  const [tab, setTab] = useState<"recommend" | "all">("recommend");
  const [detail, setDetail] = useState<Film | null>(null);
  const resultsRef = useRef<HTMLHeadingElement>(null);

  const results = useMemo(() => rankFilms(conditions, tab === "recommend" ? 3 : null), [conditions, tab]);
  const update = (patch: Partial<Conditions>) => setConditions((c) => ({ ...c, ...patch }));
  const scrollToResults = () => resultsRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    const text = message.trim();
    if (!text || status.kind === "loading") return;
    setStatus({ kind: "loading" });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CLIENT_TIMEOUT_MS);
    try {
      const res = await fetch("/api/recommend", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, dayOffset: conditions.dayOffset }),
        signal: controller.signal,
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.conditions) throw new Error(data?.error ?? "サーバーに接続できませんでした。");
      setConditions(data.conditions);
      setInterpreted(data.conditions);
      setTab("recommend");
      setStatus({ kind: "success", source: data.source, notice: data.notice });
    } catch (err) {
      // 通信失敗時もローカル解釈で検索を継続（FR-07）
      const fallback = localParse(text, conditions.dayOffset);
      setConditions(fallback);
      setInterpreted(fallback);
      const reason = err instanceof Error && err.name !== "AbortError" ? err.message : "応答がタイムアウトしました。";
      setStatus({ kind: "error", message: `${reason} キーワードから条件を推定しました。下の条件を修正して検索できます。` });
    } finally {
      clearTimeout(timer);
      setTimeout(scrollToResults, 50);
    }
  }

  function reset() {
    setConditions(EMPTY_CONDITIONS);
    setInterpreted(null);
    setTab("recommend");
    setStatus({ kind: "idle" });
  }

  return (
    <>
      <header className="topbar">
        <div className="wrap topbar-inner">
          <a className="brand" href="#top" aria-label="Movie AI Chatbot トップ">
            <span className="brand-mark" aria-hidden="true">✦</span>
            <span>MOVIE AI <small>CHATBOT</small></span>
          </a>
          <nav className="nav" aria-label="メインメニュー">
            <a href="#consult">相談する</a>
            <a href="#discover">上映スケジュール</a>
            <a href="#for-theater">映画館の方へ</a>
          </nav>
          <span className="theater-pill">◉ シネマ・デモ館</span>
        </div>
      </header>
      <div className="demo-note">デモ版です。作品・上映日時・映画館はすべて架空のデータです。</div>

      <main id="top">
        <section className="hero" id="consult">
          <div className="wrap hero-grid">
            <div className="hero-copy">
              <div className="eyebrow">YOUR NEXT FAVORITE FILM</div>
              <h1>今夜の一本、<br /><em>まだ決めてない？</em></h1>
              <p>観たい気分を、そのまま言葉で。いま上映している作品の中から、AIが条件を読み取っておすすめを3本選びます。</p>
            </div>
            <form className="consult" onSubmit={submit} aria-labelledby="consult-title">
              <h2 id="consult-title" className="consult-title">映画について相談する</h2>
              <label htmlFor="message" className="sr-only">相談文</label>
              <textarea
                id="message"
                value={message}
                maxLength={MAX_MESSAGE_LENGTH}
                rows={3}
                placeholder="例：今日は気軽に笑える100分以内の映画"
                onChange={(e) => setMessage(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
                }}
              />
              <div className="consult-row">
                <div className="examples" aria-label="入力例">
                  {EXAMPLES.map((ex) => (
                    <button key={ex} type="button" className="example" onClick={() => setMessage(ex)}>{ex}</button>
                  ))}
                </div>
                <span className="counter" aria-live="polite">{[...message].length}/{MAX_MESSAGE_LENGTH}</span>
              </div>
              <button className="primary" type="submit" disabled={!message.trim() || status.kind === "loading"}>
                {status.kind === "loading" ? "AIが条件を読み取っています…" : "✦ AIにおすすめを聞く"}
              </button>
              <div aria-live="polite">
                {status.kind === "success" && (
                  <p className={`status ${status.source === "gemini" ? "ok" : "warn"}`}>
                    {status.source === "gemini" ? "AIが条件を読み取りました。下で確認・修正できます。" : status.notice}
                  </p>
                )}
                {status.kind === "error" && <p className="status err" role="alert">{status.message}</p>}
              </div>
            </form>
          </div>
        </section>

        <section className="section wrap" id="discover">
          <div className="section-heading">
            <div>
              <div className="eyebrow">FIND YOUR FILM</div>
              <h2>読み取った条件とおすすめ</h2>
            </div>
            {interpreted && (
              <ul className="badges" aria-label="AIが読み取った条件">
                <li>ジャンル：{interpreted.genre ?? "指定なし"}</li>
                <li>気分：{interpreted.mood ?? "指定なし"}</li>
                <li>時間：{interpreted.maxMinutes ? `${interpreted.maxMinutes}分以内` : "指定なし"}</li>
                <li>日付：{dayLabel(interpreted.dayOffset)}</li>
              </ul>
            )}
          </div>

          <div className="workspace">
            <aside className="filters" aria-label="検索条件の修正">
              <div className="filters-head">条件を確認・修正</div>
              <ChipGroup label="ジャンル" items={GENRES} value={conditions.genre} onChange={(genre) => update({ genre })} />
              <ChipGroup label="気分" items={MOODS} value={conditions.mood} onChange={(mood) => update({ mood })} />
              <div className="filter-group">
                <label className="filter-title" htmlFor="runtime">観られる時間</label>
                <select
                  id="runtime"
                  value={conditions.maxMinutes ?? 0}
                  onChange={(e) => update({ maxMinutes: Number(e.target.value) || null })}
                >
                  <option value={0}>時間は気にしない</option>
                  {conditions.maxMinutes !== null && !(RUNTIME_OPTIONS as readonly number[]).includes(conditions.maxMinutes) && (
                    <option value={conditions.maxMinutes}>{conditions.maxMinutes}分以内</option>
                  )}
                  {RUNTIME_OPTIONS.map((m) => <option key={m} value={m}>{m}分以内</option>)}
                </select>
              </div>
              <button className="primary" type="button" onClick={() => { setTab("recommend"); scrollToResults(); }}>
                ✦ この条件でおすすめを探す
              </button>
              <button className="clear" type="button" onClick={reset}>条件をリセットする</button>
            </aside>

            <div className="output">
              <div className="filter-title">鑑賞日 <small>7日間のデモ上映予定</small></div>
              <div className="date-strip" role="group" aria-label="鑑賞する日">
                {Array.from({ length: DAYS }, (_, i) => {
                  const d = dayAt(i);
                  return (
                    <button key={i} type="button" className="date" aria-pressed={conditions.dayOffset === i} onClick={() => update({ dayOffset: i })}>
                      <span>{i === 0 ? "今日" : new Intl.DateTimeFormat("ja-JP", { weekday: "short" }).format(d)}</span>
                      <b>{d.getMonth() + 1}/{d.getDate()}</b>
                    </button>
                  );
                })}
              </div>
              <div className="results-bar">
                <div>
                  <h3 ref={resultsRef}>{tab === "recommend" ? "あなたへのおすすめ" : "上映中の作品一覧"}</h3>
                  <p aria-live="polite">{fullDate(conditions.dayOffset)}｜{results.length}作品</p>
                </div>
                <div className="tabs" role="group" aria-label="表示切替">
                  <button type="button" className="tab" aria-pressed={tab === "recommend"} onClick={() => setTab("recommend")}>おすすめ</button>
                  <button type="button" className="tab" aria-pressed={tab === "all"} onClick={() => setTab("all")}>すべての作品</button>
                </div>
              </div>
              <div className="movie-list">
                {results.length === 0 ? (
                  <div className="empty"><b>条件に合う上映作品がありません</b><span>ジャンル・気分・時間・日付を変更してみてください。</span></div>
                ) : (
                  results.map((r, i) => (
                    <article className="movie" key={r.id} data-testid="movie" data-minutes={r.film.minutes}>
                      <div className={`poster ${r.film.theme}`} aria-hidden="true">
                        <span className="poster-sub">CINEMA / ORIGINAL</span>
                        <span className="poster-name">{r.film.name}</span>
                      </div>
                      <div className="movie-main">
                        <div className="movie-top">
                          <span className="rank">{tab === "recommend" ? `RECOMMEND #${i + 1}` : "NOW SHOWING"}</span>
                          <span className="score">{r.score}<small> / 100</small></span>
                        </div>
                        <h4>{r.film.name}</h4>
                        <div className="meta">{r.film.genre.join("・")}｜{r.film.minutes}分｜監督 {r.film.director}</div>
                        <p className="reason"><span className="sparkle" aria-hidden="true">✦</span><span>{r.reason}</span></p>
                        <div className="showtimes">
                          <span className="showtime-label">上映時刻</span>
                          {r.times.map((t) => <span key={t} className="showtime">{t}</span>)}
                        </div>
                        <button type="button" className="detail-link" onClick={() => setDetail(r.film)}>作品の詳細を見る ↗</button>
                      </div>
                    </article>
                  ))
                )}
              </div>
            </div>
          </div>
        </section>

        <section className="info-section" id="for-theater">
          <div className="wrap">
            <div className="section-heading"><div><div className="eyebrow">FOR LOCAL CINEMAS</div><h2>小さな映画館にも、出会いの仕組みを。</h2></div></div>
            <div className="info-grid">
              <div className="info-card"><b>上映中の作品だけを推薦</b><p>AIは条件の読み取りのみを担当。作品と上映時刻は映画館のデータだけから表示します。</p></div>
              <div className="info-card"><b>話しかけるように探せる</b><p>「泣ける映画」「100分以内」など、ふだんの言葉で相談できます。</p></div>
              <div className="info-card"><b>管理機能は次の段階へ</b><p>作品登録・上映管理・分析は、MVP検証後に追加予定です。</p></div>
            </div>
          </div>
        </section>
      </main>
      <footer>
        <div className="wrap footer-inner">
          <span>© Movie AI Chatbot — MVP demo</span>
          <span>架空作品・架空上映予定のみ使用。外部映画データ・画像は使用していません。</span>
        </div>
      </footer>
      <DetailDialog film={detail} dayOffset={conditions.dayOffset} onClose={() => setDetail(null)} />
    </>
  );
}

function ChipGroup<T extends string>(props: { label: string; items: readonly T[]; value: T | null; onChange: (v: T | null) => void }) {
  return (
    <div className="filter-group">
      <div className="filter-title" id={`chips-${props.label}`}>{props.label} <small>1つ選択</small></div>
      <div className="chips" role="group" aria-labelledby={`chips-${props.label}`}>
        <button type="button" className="chip" aria-pressed={props.value === null} onClick={() => props.onChange(null)}>指定なし</button>
        {props.items.map((item) => (
          <button key={item} type="button" className="chip" aria-pressed={props.value === item} onClick={() => props.onChange(item)}>{item}</button>
        ))}
      </div>
    </div>
  );
}

function DetailDialog({ film, dayOffset, onClose }: { film: Film | null; dayOffset: number; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (film && !d.open) d.showModal();
    if (!film && d.open) d.close();
  }, [film]);
  const times = film ? timesFor(film, dayOffset) : [];
  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-labelledby="dialog-title"
      onClose={onClose}
      onClick={(e) => { if (e.target === ref.current) onClose(); }}
    >
      {film && (
        <div className="dialog-body">
          <button className="dialog-close" type="button" aria-label="閉じる" onClick={onClose}>×</button>
          <div className="dialog-tag">MOVIE DETAILS · 架空作品</div>
          <h2 id="dialog-title">{film.name}</h2>
          <div className="meta">{film.genre.join("・")} ／ {film.minutes}分 ／ 監督 {film.director}</div>
          <p>{film.synopsis}</p>
          <div className="dialog-tag">上映予定 — {fullDate(dayOffset)}</div>
          <div className="dialog-times">{times.length ? times.map((t) => <span key={t}>{t}</span>) : "この日の上映はありません"}</div>
        </div>
      )}
    </dialog>
  );
}
