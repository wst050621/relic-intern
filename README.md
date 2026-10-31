# Movie AI Chatbot — MVP

映画館の（架空の）上映予定から、自然言語の相談に合う作品を最大3本推薦するデモ。

- **フロント**: React + TypeScript + Vite（`src/`）
- **API**: Vercel Function `POST /api/recommend`（`api/recommend.ts` → `server/recommendCore.ts`）
- **実行時LLM**: Gemini（`@google/genai`）。相談文を `genre / mood / maxMinutes / dayOffset` に正規化するだけ。
- **推薦**: `shared/recommend.ts` が登録済み作品（`shared/films.ts`）から決定的にスコアリング。作品名・上映時刻はローカルデータが唯一の正本で、Geminiには生成させない。
- **フォールバック**: キー未設定・429・タイムアウト・通信失敗時はキーワードによるローカル解釈で推薦を継続。

## API

```http
POST /api/recommend
Content-Type: application/json

{ "message": "明日、ドキドキするSF", "dayOffset": 0 }
```

```json
{
  "source": "gemini",
  "conditions": { "genre": "SF", "mood": "ドキドキしたい", "maxMinutes": null, "dayOffset": 1 },
  "recommendations": [{ "id": "star", "score": 99, "reason": "SFの作品・「ドキドキしたい」気分にぴったり。", "times": ["11:30", "16:45", "20:10"] }]
}
```

`source: "local"` の場合は `notice` に理由が入る。405 / 415 / 400（空・300字超）は `{ "error": "..." }`。

## 開発

```bash
npm install
GEMINI_API_KEY=... npm run dev   # キーなしでもローカル推薦で動作
npm test
npm run build
```

## Vercel デプロイ

| 項目 | 値 |
| --- | --- |
| Framework Preset | Vite |
| Root Directory | `./` |
| Build Command | `npm run build` |
| Output Directory | `dist` |
| Install Command | `npm install` |
| 環境変数 | `GEMINI_API_KEY`（必須・秘密）、`GEMINI_MODEL=gemini-3.6-flash` |

- `api/recommend.ts` は追加設定なしで `/api/recommend` の Node.js Function になる（`vercel.json` 不要）。
- GitHub Secrets は Vercel に自動では渡らない。Vercel の Environment Variables に別途登録する。`VITE_` 接頭辞は付けないこと。
- 環境変数を追加・変更した後は再デプロイが必要。
- Production Branch（通常 `main`）にアプリ本体が入っている状態で Import すること。
- 公開デモのため Google AI Studio 側で予算・クォータを確認する。

作品・上映予定・ポスターはすべて架空／CSSによる自作装飾です。

## 技術スタック

| 領域 | 技術 |
| --- | --- |
| フロント | React 18 + TypeScript + Vite、CSS（UIライブラリなし） |
| API | Vercel Function（Node.js）`api/recommend.ts` |
| 実行時LLM | Gemini（`@google/genai`、既定 `gemini-3.6-flash`）＋ Zod による出力検証 |
| テスト | Vitest（単体 36件）、Playwright（ブラウザでの表示・操作確認） |
| デプロイ | GitHub → Vercel（`main` が Production） |
| Phase 2 設計 | Supabase（PostgreSQL・Auth・RLS）を想定。**設計案のみで未実装** |

## サイトマップ

```
/                      利用者サイト（本番公開）：相談 → 条件の確認・修正 → おすすめ最大3本／上映作品一覧／作品詳細
/api/recommend         推薦 API（POST のみ）
/admin-demo.html       デモ用管理画面（本番公開。架空データ・メモリ上のみ・認証なし・保存されない）
/admin-mock.html       同じ画面の開発サーバー用の入口（本番ビルドには含まれない）
  ├ 作品管理           一覧・検索・絞り込み、登録・編集（ドロワー）、削除確認
  └ 上映スケジュール   週の移動、週間表示／一覧表示、上映回の追加・編集・削除、未割り当て、一括登録
```

## 管理画面モックの操作手順

公開デモ：https://relic-intern-kohl.vercel.app/admin-demo.html （画面上部に「デモ用管理画面｜変更内容は保存されません」と常時表示。API・DB・認証には接続しない）

ローカルで開く場合：

```bash
npm install
npm run dev
# ブラウザで http://localhost:5173/admin-mock.html（または /admin-demo.html）
```

- 画面上部に「デモ用UIモック」と表示される。**データはメモリ上だけで、再読み込みすると初期データに戻る。認証は未実装。**
- **作品管理**：「＋ 作品を登録」で登録。作品名または「編集」で編集。「削除」は確認ダイアログを経て削除。
- **上映スケジュール**
  1. 「‹ 前週」「翌週 ›」で週を移動し、「今週に戻る」で今日の週に戻る。
  2. 「週間表示」は日付ボタンとシアター別の列、「一覧表示」は表示中の週の上映回を表で表示する。
  3. 「＋ 上映回を追加」で1回分を追加する（下書き）。各上映回の「編集」「削除」で変更・削除する。重なる場合は原因を表示して保存しない。
  4. 未割り当ての上映回は、シアターを選んで「割り当て」を押す。
  5. **一括登録**：「＋ 一括登録」→ 作品・シアター・開始日・終了日（表示中の週の範囲）・上映開始時刻（`1000, 13:30` のようにカンマ区切り）を入力 →「登録内容を確認」で全行・件数・重複の原因を確認 →「一括登録」。1件でも重複があれば何も登録されない。登録した上映回は下書きになる。

## 要求と実装の対応

| 要求 | 内容 | 状態 |
| --- | --- | --- |
| FR-01〜FR-10（MVP） | 自然言語相談、Gemini 解釈、上映作品から最大3本の推薦、推薦理由、条件の修正、作品詳細、失敗時のローカル推薦、レスポンシブ、架空データのみ、Vercel 公開 | ✅ 本番公開済み |
| F-01 作品一覧 | 作品名・ジャンル・監督・上映時間・公開状態・上映予定数、検索・絞り込み | ✅ モック |
| F-02 作品登録・編集 | 入力検証、削除確認ダイアログ、気分タグ | ✅ モック |
| F-03 上映スケジュール | 日付別・シアター別、追加・編集・削除、重複検出（入れ替え15分）、未割り当て | ✅ モック |
| 一括登録 | 期間 × 複数時刻、プレビュー、既存・登録内容どうしの重複検出、全件拒否、下書き | ✅ モック |
| 週間表示 | 前週・翌週、今週に戻る、週間表示／一覧表示、一括登録の期間連動 | ✅ モック |
| F-04 推薦との連携 | 管理画面のデータを推薦が参照する | ⬜ 設計のみ（`docs/phase2/detailed-design.md`） |

## 未実装（次の開発段階）

- **データの保存**：Supabase（DB・マイグレーション）。SQL は `docs/phase2/schema-draft.sql` の設計案で、未実行・未検証
- **認証・権限**：Supabase Auth、RLS、管理 API。**認証がないため、本物の管理画面は公開しない**（公開しているのはデモ専用の `/admin-demo.html` のみ）
- **推薦との連携**：管理画面で登録した上映予定を、利用者サイトと推薦で参照する
- 延期した機能：シアター管理（座席数・休止）、予告時間、曜日指定・除外日、管理者向けの訂正機能（上映中止・誤登録）
- 商用利用の条件確認：Vercel Hobby は非商用利用が前提。Supabase・Gemini・映画データの条件も要確認（`docs/phase2/detailed-design.md` §13）

詳しい設計資料は `docs/phase2/` を参照。
