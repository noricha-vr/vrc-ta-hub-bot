import { validateHubBaseUrl } from "./config";

export interface HubCommunity {
  id: number;
  name: string;
  role: "owner" | "staff";
  recording_allowed: boolean;
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

  async communities(discordId: string): Promise<HubCommunity[]> {
    if (!/^[0-9]{17,20}$/.test(discordId)) throw new Error("Invalid Discord ID");
    try {
      const url = new URL("/api/v1/community-by-discord/", this.baseUrl);
      url.searchParams.set("discord_id", discordId);
      const response = await this.request(url, {
        headers: { Authorization: `Api-Key ${this.apiKey}` },
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
