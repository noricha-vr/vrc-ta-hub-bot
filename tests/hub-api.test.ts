import { expect, test } from "bun:test";
import { HubApi, type HubCommunity } from "../src/hub-api";

const userId = "123456789012345678";
const community: HubCommunity = { id: 1, name: "テスト集会", role: "owner", recording_allowed: false };

test("lookup uses the supplied transport, authenticated endpoint, and actual response envelope", async () => {
  let calls = 0;
  const hub = new HubApi("https://example.invalid/subpath", "synthetic-key", (async (input, options) => {
    calls++;
    expect(String(input)).toBe(`https://example.invalid/api/v1/community-by-discord/?discord_id=${userId}`);
    expect(options?.headers).toEqual({ "X-API-Key": "synthetic-key" });
    expect(options?.redirect).toBe("error");
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    return Response.json({ discord_id: userId, communities: [community, { ...community, id: 2, role: "staff", recording_allowed: true }, { ...community, id: 3, role: "member" }] });
  }));
  expect(await hub.communities(userId)).toEqual([community, { ...community, id: 2, role: "staff", recording_allowed: true }]);
  expect(calls).toBe(1);
});

test("empty membership stays empty; invalid IDs do not invoke the transport", async () => {
  let calls = 0;
  const hub = new HubApi("https://example.invalid", "synthetic-key", (async () => {
    calls++; return Response.json({ discord_id: userId, communities: [] });
  }));
  expect(await hub.communities(userId)).toEqual([]);
  for (const id of ["", "1".repeat(16), "1".repeat(21), `${userId}\n`, "a".repeat(18)]) {
    await expect(hub.communities(id)).rejects.toThrow("Invalid Discord ID");
  }
  expect(calls).toBe(1);
});

test("lookup fails closed and redacts upstream errors and malformed payloads", async () => {
  for (const payload of [{}, [], { discord_id: "other", communities: [] }, { discord_id: userId, communities: [{ ...community, recording_allowed: "false" }] }]) {
    const hub = new HubApi("https://example.invalid", "synthetic-key", (async () => Response.json(payload)));
    await expect(hub.communities(userId)).rejects.toThrow("Hub lookup failed");
  }
  for (const request of [async () => new Response("sensitive", { status: 403 }), async () => { throw new Error("sensitive"); }]) {
    await expect(new HubApi("https://example.invalid", "synthetic-key", request).communities(userId))
      .rejects.toThrow(/^Hub lookup failed$/);
  }
});

test("direct API construction also rejects plaintext credentials before using the transport", () => {
  let calls = 0;
  const request = async () => { calls++; return Response.json({}); };
  expect(() => new HubApi("http://example.invalid", "synthetic-key", request)).toThrow("requires HTTPS");
  expect(calls).toBe(0);
});

test("event pages are read completely and cross-origin pagination never receives the API key", async () => {
  let calls = 0;
  const hub = new HubApi("https://example.invalid", "synthetic-key", async (url, init) => {
    calls++;
    expect(init.headers).toEqual({ "X-API-Key": "synthetic-key" });
    return url.searchParams.has("page")
      ? Response.json({ results: [{ id: 2, date: "2026-10-26", community: { id: 1 } }], next: null })
      : Response.json({ results: [{ id: 1, date: "2026-10-25", community: { id: 1 } }], next: "?community=1&page=2" });
  });
  expect(await hub.events(1)).toEqual([
    { id: 1, date: "2026-10-25", communityId: 1 }, { id: 2, date: "2026-10-26", communityId: 1 },
  ]);
  expect(calls).toBe(2);
  for (const next of ["https://other.invalid/api/v1/event/", "https://example.invalid/other/", "?community=1"]) {
    let requests = 0;
    const bad = new HubApi("https://example.invalid", "synthetic-key", async () => {
      requests++; return Response.json({ results: [], next });
    });
    await expect(bad.events(1)).rejects.toThrow("Hub request failed");
    expect(requests).toBe(1);
  }
});

test("draft reconciliation scans pages, matches exact source and rejects ambiguous matches", async () => {
  const source = "https://discord.com/channels/100/10/101";
  const hub = new HubApi("https://example.invalid", "synthetic-key", async url => url.searchParams.has("page")
    ? Response.json({ results: [{ id: 42, source_url: source, source: "discord_bot", status: "pending" }], next: null })
    : Response.json({ results: [{ id: 1, source_url: source, source: "manual" }], next: "?page=2" }));
  expect(await hub.findDraft(source)).toMatchObject({ id: 42, status: "pending" });
  for (const payload of [
    [{ id: 1, source_url: source, source: "discord_bot" }, { id: 2, source_url: source, source: "discord_bot" }],
    [{ id: "invalid", source_url: source, source: "discord_bot" }],
    { results: "invalid" },
  ]) {
    const bad = new HubApi("https://example.invalid", "synthetic-key", async () => Response.json(payload));
    await expect(bad.findDraft(source)).rejects.toThrow("Hub request failed");
  }
});

test("write API errors never expose response bodies, credentials or transport details", async () => {
  for (const request of [async () => new Response("synthetic-secret", { status: 503 }),
    async () => { throw new Error("synthetic-secret"); }, async () => Response.json({ id: "bad" })]) {
    const hub = new HubApi("https://example.invalid", "synthetic-key", request);
    await expect(hub.createDraft({ event: 7, detail_type: "LT", speaker: "speaker", theme: "theme", slide_url: "", additional_info: "" },
      "https://discord.com/channels/100/10/101")).rejects.toThrow(/^Hub request failed$/);
  }
});
