import { expect, test } from "bun:test";
import { loadConfig } from "../src/config";

const env = {
  DISCORD_TOKEN: "test-placeholder", HUB_API_KEY: "test-placeholder", JEV_API_KEY: "test-placeholder",
  HUB_BASE_URL: "https://example.invalid",
};

test("configuration starts without fixed channels and reserves API settings", () => {
  const config = loadConfig(env);
  expect("channelIds" in config).toBe(false);
  expect(config.hubBaseUrl).toBe("https://example.invalid");
  expect(config.dataDir.endsWith("/data")).toBe(true);
});

test("invalid settings fail without exposing provided values", () => {
  expect(() => loadConfig({ ...env, DISCORD_TOKEN: "" })).toThrow("DISCORD_TOKEN");
  expect(() => loadConfig({ ...env, HUB_BASE_URL: "not-a-url" })).toThrow("HTTP(S)");
  expect(() => loadConfig({ ...env, HUB_BASE_URL: "https://user:password@example.invalid" })).toThrow("without credentials");
});

test("Hub API keys require HTTPS except on the two local HTTP hosts", () => {
  for (const url of ["http://example.invalid", "http://localhost.example.invalid", "http://127.0.0.2", "ftp://localhost", "http://[::1]"]) {
    expect(() => loadConfig({ ...env, HUB_BASE_URL: url })).toThrow("requires HTTPS");
  }
  for (const url of ["https://example.invalid", "http://localhost:8080", "http://127.0.0.1:8080/path"]) {
    expect(loadConfig({ ...env, HUB_BASE_URL: url }).hubBaseUrl).toBe(url);
  }
});
