export interface ChoiceQuestion {
  type: "choice";
  instructions: string;
  criteria: Record<string, string>;
}

export interface ChoiceAnswer {
  answer: string;
  confidence: number;
}

/** state は投稿本文のみ。選択肢にも表示名・添付・下書きの本文を追加しない。 */
export interface JudgeRequest {
  state: string;
  questions: Record<string, ChoiceQuestion>;
}

export interface Judge {
  ask(request: JudgeRequest): Promise<Record<string, ChoiceAnswer>>;
}

export type JudgeFailure = "timeout" | "transport" | "server" | "http" | "invalid_response" | "invalid_request";

export class JudgeError extends Error {
  constructor(readonly reason: JudgeFailure) {
    super(`Judgement failed: ${reason}`);
  }
}

export type JudgeFetch = (url: string, init: RequestInit) => Promise<Response>;

/** 判定 API の choice 応答（{type:"choice", choice, confidence}）を内部の形に変換する。 */
export function fromWireAnswer(value: unknown): ChoiceAnswer | undefined {
  if (!value || typeof value !== "object") return undefined;
  const wire = value as { type?: unknown; choice?: unknown; confidence?: unknown };
  if (wire.type !== "choice" || typeof wire.choice !== "string" || typeof wire.confidence !== "number") return undefined;
  return { answer: wire.choice, confidence: wire.confidence };
}

export function validAnswer(value: unknown, criteria: Record<string, string>): value is ChoiceAnswer {
  if (!value || typeof value !== "object") return false;
  const answer = value as Partial<ChoiceAnswer>;
  return typeof answer.answer === "string" && Object.hasOwn(criteria, answer.answer)
    && typeof answer.confidence === "number" && Number.isFinite(answer.confidence)
    && answer.confidence >= 0 && answer.confidence <= 1;
}

/** HTTP 境界は差し替え可能。生のレスポンスや例外は外へ返さない。 */
export class JevJudge implements Judge {
  constructor(
    private readonly apiKey: string,
    private readonly fetcher: JudgeFetch = (url, init) => fetch(url, init),
    private readonly timeoutMs = 10_000,
  ) {
    if (!apiKey.trim() || !Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new JudgeError("invalid_request");
  }

  async ask(request: JudgeRequest): Promise<Record<string, ChoiceAnswer>> {
    const questions = Object.entries(request.questions);
    const body = JSON.stringify({ model: "jev-latest", state: request.state, questions: request.questions });
    // バイト数で保守的に制限し、約 32,000 トークンの入力枠を超えない。
    if (questions.length === 0 || questions.length > 100 || Buffer.byteLength(body) > 32_000
      || questions.some(([, q]) => q.type !== "choice" || !Object.hasOwn(q.criteria, "none"))) {
      throw new JudgeError("invalid_request");
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new JudgeError("timeout"));
          controller.abort();
        }, this.timeoutMs);
      });
      return await Promise.race([this.send(body, request, controller.signal), timeout]);
    } catch (error) {
      throw error instanceof JudgeError ? error : new JudgeError("transport");
    } finally {
      clearTimeout(timer);
    }
  }

  private async send(body: string, request: JudgeRequest, signal: AbortSignal): Promise<Record<string, ChoiceAnswer>> {
    const response = await this.fetcher("https://api.typesafe.ai/v1/systemone", {
      method: "POST", redirect: "error", signal,
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" }, body,
    });
    if (!response.ok) throw new JudgeError(response.status >= 500 || response.status === 429 ? "server" : "http");
    let data: unknown;
    try { data = await response.json(); } catch { throw new JudgeError("invalid_response"); }
    if (!data || typeof data !== "object" || !("answers" in data)
      || !data.answers || typeof data.answers !== "object") throw new JudgeError("invalid_response");
    const answers = data.answers as Record<string, unknown>;
    const result: Record<string, ChoiceAnswer> = {};
    for (const [name, question] of Object.entries(request.questions)) {
      const value = fromWireAnswer(answers[name]);
      if (!validAnswer(value, question.criteria)) throw new JudgeError("invalid_response");
      result[name] = { answer: value.answer, confidence: value.confidence };
    }
    return result;
  }
}
