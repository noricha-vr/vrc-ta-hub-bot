import { expect, test } from "bun:test";
import { loadConfig } from "../src/config";

const env = {
  DISCORD_TOKEN: "test-placeholder", HUB_API_KEY: "test-placeholder", JEV_API_KEY: "test-placeholder",
  HUB_BASE_URL: "https://example.invalid", DISCORD_CHANNEL_IDS: "10, 11,10",
};

test("configuration selects channels explicitly and reserves API settings", () => {
  const config = loadConfig(env);
  expect(config.channelIds).toEqual(["10", "11"]);
  expect(config.hubBaseUrl).toBe("https://example.invalid");
  expect(config.dataDir.endsWith("/data")).toBe(true);
});

test("invalid settings fail without exposing provided values", () => {
  expect(() => loadConfig({ ...env, DISCORD_TOKEN: "" })).toThrow("DISCORD_TOKEN");
  expect(() => loadConfig({ ...env, DISCORD_CHANNEL_IDS: "10," })).toThrow("channel IDs");
  expect(() => loadConfig({ ...env, HUB_BASE_URL: "not-a-url" })).toThrow("HTTP(S)");
  expect(() => loadConfig({ ...env, HUB_BASE_URL: "https://user:password@example.invalid" })).toThrow("without credentials");
});
