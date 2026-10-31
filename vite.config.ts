/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// ローカル開発用: /api/recommend を Vercel Function と同じ本体で処理する
function devApi(): Plugin {
  return {
    name: "dev-api",
    configureServer(server) {
      server.middlewares.use("/api/recommend", async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        let body: unknown = null;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "null");
        } catch {
          body = null;
        }
        const { handleRecommend } = await server.ssrLoadModule("/server/recommendCore.ts");
        const result = await handleRecommend(
          { method: req.method, contentType: req.headers["content-type"], body },
          { GEMINI_API_KEY: process.env.GEMINI_API_KEY, GEMINI_MODEL: process.env.GEMINI_MODEL },
          { log: (m: string) => console.warn(m) },
        );
        res.statusCode = result.status;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify(result.body));
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), devApi()],
  test: { include: ["tests/**/*.test.ts"] },
});
