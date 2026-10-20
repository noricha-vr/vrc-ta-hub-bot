import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";

export interface Config {
  discordToken: string;
  hubApiKey: string;
  hubBaseUrl: string;
  jevApiKey: string;
  dataDir: string;
}

export class ConfigConflictError extends Error {
  constructor(readonly keys: string[]) {
    super(`Environment conflicts with BOT_ENV_FILE: ${keys.join(", ")}`);
  }
}

export function loadConfigFile(env: Record<string, string | undefined>): Config & { envFilePath: string } {
  const envFilePath = resolve(env.BOT_ENV_FILE?.trim() || ".env.local");
  let fileEnv: Record<string, string | undefined>;
  try { fileEnv = parseEnv(readFileSync(envFilePath, "utf8")); }
  catch { throw new Error("Cannot read BOT_ENV_FILE"); }
  const conflicts = Object.keys(fileEnv).filter(key => env[key] !== undefined && env[key] !== fileEnv[key]).sort();
  if (conflicts.length) throw new ConfigConflictError(conflicts);
  return { ...loadConfig({ ...env, ...fileEnv }), envFilePath };
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
