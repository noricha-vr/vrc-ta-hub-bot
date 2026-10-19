import { resolve } from "node:path";

export interface Config {
  discordToken: string;
  hubApiKey: string;
  hubBaseUrl: string;
  jevApiKey: string;
  dataDir: string;
}

export function validateHubBaseUrl(value: string): void {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error("HUB_BASE_URL must be an HTTP(S) URL"); }
  if (url.username || url.password) throw new Error("HUB_BASE_URL must be without credentials");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) {
    throw new Error("HUB_BASE_URL requires HTTPS (HTTP is allowed only for localhost or 127.0.0.1)");
  }
}

export function loadConfig(env: Record<string, string | undefined>): Config {
  const required = (name: string): string => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`Missing environment variable: ${name}`);
    return value;
  };
  const hubBaseUrl = required("HUB_BASE_URL");
  validateHubBaseUrl(hubBaseUrl);
  return {
    discordToken: required("DISCORD_TOKEN"),
    hubApiKey: required("HUB_API_KEY"),
    hubBaseUrl,
    jevApiKey: required("JEV_API_KEY"),
    dataDir: resolve(env.BOT_DATA_DIR?.trim() || "data"),
  };
}
