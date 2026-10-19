import { expect, test } from "bun:test";
import { Client, Events, GatewayIntentBits, IntentsBitField, PermissionFlagsBits } from "discord.js";
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
    client.emit(Events.ShardDisconnect, { code: 1000, reason: "test", wasClean: true }, 0);
    client.emit(Events.ShardReconnecting, 0);
    client.emit(Events.ShardResume, 0, 2);
    client.emit(Events.ShardReady, 0, undefined);
    client.emit(Events.Error, new Error("fake"));
    client.emit(Events.ShardError, new Error("fake"), 0);
    client.emit(Events.Invalidated);
    expect({ connected, disconnected, reconnecting, errors, fatal }).toEqual({
      connected: 3, disconnected: 1, reconnecting: 1, errors: 2, fatal: 1,
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
