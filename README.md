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
