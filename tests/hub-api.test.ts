import { expect, test } from "bun:test";
import { HubApi, type HubCommunity } from "../src/hub-api";

const userId = "123456789012345678";
const community: HubCommunity = { id: 1, name: "テスト集会", role: "owner", recording_allowed: false };

test("lookup uses the supplied transport, authenticated endpoint, and actual response envelope", async () => {
  let calls = 0;
  const hub = new HubApi("https://example.invalid/subpath", "synthetic-key", (async (input, options) => {
    calls++;
    expect(String(input)).toBe(`https://example.invalid/api/v1/community-by-discord/?discord_id=${userId}`);
    expect(options?.headers).toEqual({ Authorization: "Api-Key synthetic-key" });
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
