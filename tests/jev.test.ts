import { expect, test } from "bun:test";
import { JevJudge, JudgeError, type JudgeFetch, type JudgeRequest } from "../src/jev";

const request: JudgeRequest = {
  state: "次回の LT に応募します",
  questions: { category: { type: "choice", instructions: "Select the kind of post.", criteria: { application: "LT application", none: "Uncertain" } } },
};
const response = () => Response.json({
  model: "jev-latest", answers: { category: { answer: "application", confidence: 0.9, probabilities: { application: 0.9, none: 0.1 } } },
  usage: { input_tokens: 30 },
});

test("判定 API の指定された形式を偽 HTTP に送り、回答だけを返す", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const judge = new JevJudge("test-placeholder", async (url, init) => { calls.push({ url, init }); return response(); });
  expect(await judge.ask(request)).toEqual({ category: { answer: "application", confidence: 0.9 } });
  expect(calls).toHaveLength(1);
  expect(calls[0]!.url).toBe("https://api.typesafe.ai/v1/systemone");
  expect(calls[0]!.init.method).toBe("POST");
  expect(calls[0]!.init.redirect).toBe("error");
  expect(calls[0]!.init.headers).toEqual({ Authorization: "Bearer test-placeholder", "Content-Type": "application/json" });
  expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ model: "jev-latest", ...request });
});

for (const status of [500, 503, 429, 401]) {
  test(`HTTP ${status} の本文・秘密を例外に含めない`, async () => {
    const judge = new JevJudge("test-placeholder", async () => new Response("sensitive body", { status }));
    try { await judge.ask(request); throw new Error("Expected failure"); }
    catch (error) {
      expect(error).toBeInstanceOf(JudgeError);
      expect((error as JudgeError).reason).toBe(status === 401 ? "http" : "server");
      expect(String(error)).not.toContain("sensitive body");
      expect(String(error)).not.toContain("test-placeholder");
    }
  });
}

test("タイムアウトは中断し、接続失敗の生エラーも返さない", async () => {
  let signal: AbortSignal | undefined;
  const fetcher: JudgeFetch = async (_url, init) => {
    signal = init.signal as AbortSignal;
    return new Promise(() => {});
  };
  await expect(new JevJudge("test-placeholder", fetcher, 5).ask(request)).rejects.toThrow("timeout");
  expect(signal?.aborted).toBe(true);
  await expect(new JevJudge("test-placeholder", async () => { throw new Error("secret detail"); }).ask(request)).rejects.toThrow("Judgement failed: transport");
});

test("レスポンス本文の読み取りもタイムアウトの対象にする", async () => {
  const judge = new JevJudge("test-placeholder", async () => new Response(new ReadableStream({ start() {} })), 5);
  await expect(judge.ask(request)).rejects.toThrow("timeout");
});

for (const value of [null, {}, { answers: {} }, { answers: { category: { answer: "unknown", confidence: 1 } } },
  { answers: { category: { answer: "application", confidence: -0.1 } } },
  { answers: { category: { answer: "application", confidence: 1.1 } } },
  { answers: { category: { answer: "application", confidence: "0.9" } } }]) {
  test(`不正な応答 ${JSON.stringify(value)} は判定に使わない`, async () => {
    await expect(new JevJudge("test-placeholder", async () => Response.json(value)).ask(request)).rejects.toThrow("invalid_response");
  });
}

test("JSON 不正・none 欠落・100 問超・長すぎる入力を拒否する", async () => {
  const judge = new JevJudge("test-placeholder", async () => new Response("not-json"));
  await expect(judge.ask(request)).rejects.toThrow("invalid_response");
  const noNone: JudgeRequest = { state: "post", questions: { x: { type: "choice", instructions: "Choose.", criteria: { yes: "Yes" } } } };
  let calls = 0;
  const limited = new JevJudge("test-placeholder", async () => { calls++; return response(); });
  await expect(limited.ask(noNone)).rejects.toThrow("invalid_request");
  await expect(limited.ask({ ...request, state: "x".repeat(32_001) })).rejects.toThrow("invalid_request");
  await expect(limited.ask({ ...request, questions: Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`q${i}`, request.questions.category!])) })).rejects.toThrow("invalid_request");
  expect(calls).toBe(0);
});
