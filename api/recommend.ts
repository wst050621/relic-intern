import type { VercelRequest, VercelResponse } from "@vercel/node";
import { handleRecommend } from "../server/recommendCore.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  let body: unknown = null;
  try {
    body = req.body; // 不正なJSONはここで例外になる
  } catch {
    body = null;
  }
  const result = await handleRecommend(
    { method: req.method, contentType: req.headers["content-type"], body },
    { GEMINI_API_KEY: process.env.GEMINI_API_KEY, GEMINI_MODEL: process.env.GEMINI_MODEL },
    { log: (m) => console.warn(m) },
  );
  if (result.status === 405) res.setHeader("Allow", "POST");
  res.setHeader("Cache-Control", "no-store");
  res.status(result.status).json(result.body);
}
