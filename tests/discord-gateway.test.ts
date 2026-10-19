import { expect, test } from "bun:test";
import { Client, Events, GatewayIntentBits, IntentsBitField, LimitedCollection, Message, MessageManager, PermissionFlagsBits } from "discord.js";
import { clientOptions, DiscordGateway } from "../src/discord-gateway";
import type { GatewayEvents, GatewayMessage } from "../src/gateway";

test("client has only the required intents and disables mentions", () => {
  const intents = new IntentsBitField(clientOptions.intents);
  expect(intents.bitfield).toBe(GatewayIntentBits.Guilds | GatewayIntentBits.GuildMessages | GatewayIntentBits.MessageContent);
  expect(clientOptions.allowedMentions).toEqual({ parse: [], repliedUser: false });
  expect(clientOptions.shardCount).toBe(1);
});

test("adapter maps full reconnect and resume events without logging in", async () => {
  const client = new Client(clientOptions);
  const gateway = new DiscordGateway(client);
  const received: GatewayMessage[] = [];
  let connected = 0;
  let disconnected = 0;
  let reconnecting = 0;
  let errors = 0;
  let fatal = 0;
  const events: GatewayEvents = {
    connected: () => { connected++; }, disconnected: () => { disconnected++; },
    reconnecting: () => { reconnecting++; }, message: item => received.push(item),
    error: () => { errors++; }, fatal: () => { fatal++; },
  };
  const unsubscribe = gateway.subscribe(events);
  try {
    client.emit(Events.ShardReady, 0, undefined);
    expect(connected).toBe(0);
    // emit is used only to drive the local event emitter; login is never called.
    client.emit(Events.ClientReady, client as Client<true>);
    client.emit(Events.ShardReconnecting, 0);
    client.emit(Events.ShardResume, 0, 2);
    client.emit(Events.ShardReady, 0, undefined);
    client.emit(Events.Error, new Error("fake"));
    client.emit(Events.ShardError, new Error("fake"), 0);
    client.emit(Events.Invalidated);
    expect({ connected, disconnected, reconnecting, errors, fatal }).toEqual({
      connected: 3, disconnected: 0, reconnecting: 1, errors: 2, fatal: 1,
    });
    expect(received).toEqual([]);
    unsubscribe();
    client.emit(Events.ShardResume, 0, 0);
    expect(connected).toBe(3);
  } finally {
    await gateway.stop();
  }
});

test("adapter refuses missing history permission instead of returning a misleading empty page", async () => {
  const client = new Client(clientOptions);
  const gateway = new DiscordGateway(client);
  // Stub only channel REST lookup; no socket or REST request can occur.
  const original = client.channels.fetch;
  client.channels.fetch = (async () => ({
    isDMBased: () => false, isTextBased: () => true,
    guild: { members: { me: { id: "20" } } },
    permissionsFor: () => ({ has: (flags: bigint[]) => !flags.includes(PermissionFlagsBits.ReadMessageHistory) }),
  })) as unknown as typeof client.channels.fetch;
  try {
    await expect(gateway.fetchMessages("10", { after: "1", limit: 100 })).rejects.toThrow("history permissions");
  } finally {
    client.channels.fetch = original;
    await gateway.stop();
  }
});

test("a non-resumable shard disconnect is fatal so the supervisor restarts the process", async () => {
  for (const code of [4004, 4010, 4011, 4012, 4013, 4014]) {
    const client = new Client(clientOptions);
    const gateway = new DiscordGateway(client);
    let fatal = 0;
    let disconnected = 0;
    gateway.subscribe({
      connected: () => {}, disconnected: () => { disconnected++; }, reconnecting: () => {},
      message: () => {}, error: () => {}, fatal: () => { fatal++; },
    });
    client.emit(Events.ShardDisconnect, { code, reason: "test", wasClean: true } as never, 0);
    expect({ code, fatal, disconnected }).toEqual({ code, fatal: 1, disconnected: 0 });
    await gateway.stop();
  }
});

test("message bodies are not kept in the SDK message cache", () => {
  const cache = clientOptions.makeCache!(MessageManager as never, Message as never, MessageManager as never);
  expect(cache).toBeInstanceOf(LimitedCollection);
  expect((cache as LimitedCollection<string, unknown>).maxSize).toBe(0);
});

test("投稿の表示名・リンク・添付を新着と履歴で同じ形式に写す", async () => {
  const client = new Client(clientOptions);
  const gateway = new DiscordGateway(client);
  const received: GatewayMessage[] = [];
  gateway.subscribe({
    connected: () => {}, disconnected: () => {}, reconnecting: () => {},
    message: item => received.push(item), error: () => {}, fatal: () => {},
  });
  const sdkMessage = {
    id: "100", channelId: "10", author: { id: "20", displayName: "アカウント表示名" },
    member: { displayName: "集会での表示名" }, content: "応募します", createdAt: new Date("2026-10-19T00:00:00Z"),
    url: "https://example.invalid/posts/100", inGuild: () => true,
    attachments: new Map([["a1", { name: "slides.pdf", url: "https://example.invalid/slides.pdf", contentType: "application/pdf" }]]),
  } as unknown as Message<true>;
  const original = client.channels.fetch;
  client.channels.fetch = (async () => ({
    isDMBased: () => false, isTextBased: () => true,
    guild: { members: { me: { id: "20" } } }, permissionsFor: () => ({ has: () => true }),
    messages: { fetch: async () => new Map([["100", sdkMessage]]) },
  })) as unknown as typeof client.channels.fetch;
  try {
    client.emit(Events.MessageCreate, sdkMessage);
    const history = await gateway.fetchMessages("10", { limit: 100 });
    expect(received).toEqual(history);
    expect(received[0]).toMatchObject({
      authorDisplayName: "集会での表示名", sourceUrl: sdkMessage.url,
      attachments: [{ name: "slides.pdf", url: "https://example.invalid/slides.pdf", contentType: "application/pdf" }],
    });
    client.emit(Events.MessageCreate, { ...sdkMessage, member: null, attachments: new Map() } as unknown as Message<true>);
    expect(received[1]?.authorDisplayName).toBe("アカウント表示名");
  } finally {
    client.channels.fetch = original;
    await gateway.stop();
  }
});
