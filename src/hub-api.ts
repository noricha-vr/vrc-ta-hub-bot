import { validateHubBaseUrl } from "./config";
import { validEventDate } from "./extraction-fields";

export interface HubCommunity {
  id: number;
  name: string;
  role: "owner" | "staff";
  recording_allowed: boolean;
}

export interface HubEvent { id: number; date: string; communityId: number }
export type ReviewDecision = "approved" | "rejected";
export interface HubDetail {
  id: number;
  source_url?: string;
  source?: string;
  status?: string;
}
export interface HubDetailFields {
  event: number;
  detail_type: "LT";
  speaker: string;
  theme: string;
  slide_url: string;
  additional_info: string;
}
export class HubApiError extends Error {
  constructor(readonly status: number = 0) { super("Hub request failed"); }
}
export interface HubReviewApi {
  events(communityId: number): Promise<HubEvent[]>;
  findDraft(sourceUrl: string): Promise<HubDetail | undefined>;
  createDraft(fields: HubDetailFields, sourceUrl: string): Promise<number>;
  updateDraft(id: number, fields: Pick<HubDetailFields, "slide_url" | "additional_info">): Promise<void>;
  reviewDraft(id: number, decision: ReviewDecision, discordId: string): Promise<void>;
  editUrl(id: number): string;
}

export type HubRequest = (input: URL, options: RequestInit) => Promise<Response>;

export interface HubLookup {
  communities(discordId: string): Promise<HubCommunity[]>;
}

/** The transport is injectable; errors never include response bodies or credentials. */
export class HubApi implements HubLookup {
  constructor(private readonly baseUrl: string, private readonly apiKey: string, private readonly request: HubRequest = fetch) {
    validateHubBaseUrl(baseUrl);
  }

  private async json(path: string | URL, method = "GET", body?: unknown): Promise<unknown> {
    try {
      const response = await this.request(new URL(path, this.baseUrl), {
        method, headers: { "X-API-Key": this.apiKey, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        redirect: "error", signal: AbortSignal.timeout(15000),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) throw new HubApiError(response.status);
      return response.status === 204 ? undefined : await response.json();
    } catch (error) { throw error instanceof HubApiError ? error : new HubApiError(); }
  }

  /** ページの URL で認証キーを別のホストへ送らない。途中失敗を空一覧として扱わない。 */
  private async list(path: string): Promise<Record<string, unknown>[]> {
    const first = new URL(path, this.baseUrl);
    let url: URL | undefined = first;
    const seen = new Set<string>();
    const result: Record<string, unknown>[] = [];
    while (url) {
      if (url.origin !== first.origin || url.pathname !== first.pathname || url.username || url.password
        || seen.has(url.href) || seen.size >= 1000) throw new HubApiError();
      seen.add(url.href);
      const payload = await this.json(url);
      const page = Array.isArray(payload) ? payload
        : payload && typeof payload === "object" && "results" in payload ? payload.results : undefined;
      if (!Array.isArray(page) || page.some(item => !item || typeof item !== "object" || Array.isArray(item))) throw new HubApiError();
      result.push(...page);
      const next = !Array.isArray(payload) && payload && typeof payload === "object" && "next" in payload ? payload.next : null;
      if (next !== null && next !== undefined && typeof next !== "string") throw new HubApiError();
      try { url = next ? new URL(next, url) : undefined; } catch { throw new HubApiError(); }
    }
    return result;
  }

  async events(communityId: number): Promise<HubEvent[]> {
    if (!Number.isSafeInteger(communityId) || communityId <= 0) throw new HubApiError();
    const rows = await this.list(`/api/v1/event/?community=${communityId}`);
    return rows.map(row => {
      const community = row.community as { id?: unknown } | undefined;
      if (!Number.isSafeInteger(row.id) || Number(row.id) <= 0 || typeof row.date !== "string"
        || !validEventDate(row.date) || community?.id !== communityId) throw new HubApiError();
      return { id: Number(row.id), date: row.date, communityId };
    });
  }

  /** 成否不明の POST は再送しない。出典を返す API で既存行を確認できた場合だけ復帰する。 */
  async findDraft(sourceUrl: string): Promise<HubDetail | undefined> {
    const rows = (await this.list("/api/v1/event-details/")).filter(row => row.source_url === sourceUrl && row.source === "discord_bot");
    if (rows.length > 1) throw new HubApiError();
    const row = rows[0];
    if (!row) return undefined;
    if (!Number.isSafeInteger(row.id) || Number(row.id) <= 0) throw new HubApiError();
    return { id: Number(row.id), source_url: sourceUrl, source: "discord_bot",
      ...(typeof row.status === "string" ? { status: row.status } : {}) };
  }

  async createDraft(fields: HubDetailFields, sourceUrl: string): Promise<number> {
    if (!/^https:\/\/discord\.com\/channels\/[0-9]{1,20}\/[0-9]{1,20}\/[0-9]{1,20}$/.test(sourceUrl)) throw new HubApiError();
    const payload = await this.json("/api/v1/event-details/", "POST", {
      ...fields, status: "pending", source: "discord_bot", source_url: sourceUrl,
    });
    const id = payload && typeof payload === "object" && "id" in payload ? payload.id : undefined;
    if (!Number.isSafeInteger(id) || Number(id) <= 0) throw new HubApiError();
    return Number(id);
  }

  async updateDraft(id: number, fields: Pick<HubDetailFields, "slide_url" | "additional_info">): Promise<void> {
    this.checkId(id);
    await this.json(`/api/v1/event-details/${id}/`, "PATCH", fields);
  }

  async reviewDraft(id: number, decision: ReviewDecision, discordId: string): Promise<void> {
    this.checkId(id);
    if (!["approved", "rejected"].includes(decision) || !/^[0-9]{1,20}$/.test(discordId)) throw new HubApiError();
    await this.json(`/api/v1/event-details/${id}/review/`, "POST", { decision, discord_id: discordId });
  }

  private checkId(id: number): void { if (!Number.isSafeInteger(id) || id <= 0) throw new HubApiError(); }
  editUrl(id: number): string {
    this.checkId(id);
    return new URL(`/event/detail/${id}/update/`, this.baseUrl).href;
  }

  async communities(discordId: string): Promise<HubCommunity[]> {
    if (!/^[0-9]{17,20}$/.test(discordId)) throw new Error("Invalid Discord ID");
    try {
      const url = new URL("/api/v1/community-by-discord/", this.baseUrl);
      url.searchParams.set("discord_id", discordId);
      const response = await this.request(url, {
        headers: { "X-API-Key": this.apiKey },
        redirect: "error", signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error();
      const payload: unknown = await response.json();
      if (!payload || typeof payload !== "object" || !("communities" in payload)
        || !("discord_id" in payload) || payload.discord_id !== discordId || !Array.isArray(payload.communities)) throw new Error();
      const result: HubCommunity[] = [];
      for (const item of payload.communities) {
        if (!item || !Number.isSafeInteger(item.id) || item.id <= 0 || typeof item.name !== "string"
          || typeof item.recording_allowed !== "boolean") throw new Error();
        if (item.role === "owner" || item.role === "staff") result.push({
          id: item.id, name: item.name, role: item.role, recording_allowed: item.recording_allowed,
        });
      }
      return result;
    } catch {
      throw new Error("Hub lookup failed");
    }
  }
}
