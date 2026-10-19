import { resolve } from "node:path";

export interface Config {
  discordToken: string;
  hubApiKey: string;
  hubBaseUrl: string;
  jevApiKey: string;
  channelIds: string[];
  dataDir: string;
}

export function loadConfig(env: Record<string, string | undefined>): Config {
  const required = (name: string): string => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`Missing environment variable: ${name}`);
    return value;
  };
  const channelIds = [...new Set(required("DISCORD_CHANNEL_IDS").split(",").map(id => id.trim()))];
  if (channelIds.some(id => !/^[1-9]\d{0,19}$/.test(id))) {
    throw new Error("DISCORD_CHANNEL_IDS must contain comma-separated channel IDs");
  }
  const hubBaseUrl = required("HUB_BASE_URL");
  let url: URL;
  try {
    url = new URL(hubBaseUrl);
  } catch {
    throw new Error("HUB_BASE_URL must be an HTTP(S) URL");
  }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("HUB_BASE_URL must be an HTTP(S) URL without credentials");
  }
  return {
    discordToken: required("DISCORD_TOKEN"),
    hubApiKey: required("HUB_API_KEY"),
    hubBaseUrl,
    jevApiKey: required("JEV_API_KEY"),
    channelIds,
    dataDir: resolve(env.BOT_DATA_DIR?.trim() || "data"),
  };
}
