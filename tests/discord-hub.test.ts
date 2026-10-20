import { expect, test } from "bun:test";
import { ChannelType, Client, Events, MessageFlags, PermissionFlagsBits, type Interaction } from "discord.js";
import { DiscordGateway, clientOptions } from "../src/discord-gateway";
import { discordHubView, hubCommand, hubInteraction, validateHubChannels } from "../src/discord-hub";
import type { HubInteraction } from "../src/hub-setup";

test("slash command and channel selectors serialize without broadening mentions or channel types", () => {
  expect(hubCommand.toJSON().options?.map(option => option.name)).toEqual(["setup", "status", "pause", "leave"]);
  expect(hubCommand.toJSON().dm_permission).toBe(false);
  const view = discordHubView({ content: "test", controls: [
    { type: "channels", id: "hub:token:channels", multiple: true },
    { type: "select", id: "hub:token:notification", options: [{ label: "DM", value: "dm" }] },
    { type: "buttons", buttons: [{ id: "hub:token:page-1", label: "次へ" }] },
  ] });
  const row = view.components[0]!.toJSON();
  expect(row.components[0]).toMatchObject({ min_values: 1, max_values: 25, channel_types: [ChannelType.GuildText, ChannelType.GuildAnnouncement] });
  expect(view.allowedMentions).toEqual({ parse: [], repliedUser: false });
  expect(discordHubView({ content: "test", controls: [{ type: "channels", id: "hub:token:notify-channel", multiple: false }] }).components[0]!.toJSON().components[0])
    .toMatchObject({ min_values: 1, max_values: 1 });
});

function rawInteraction() {
  const replies: unknown[] = [];
  return {
    replies,
    raw: {
      guildId: "100", user: { id: "123456789012345678" }, commandName: "hub",
      options: { getSubcommand: () => "setup" },
      isChatInputCommand: () => true, isStringSelectMenu: () => false, isChannelSelectMenu: () => false, isButton: () => false,
      deferReply: async (options: unknown) => { replies.push(options); },
      editReply: async (options: unknown) => { replies.push(options); },
      followUp: async (options: unknown) => { replies.push(options); },
    },
  };
}

test("Discord interaction boundary always acknowledges privately and removes controls on completion", async () => {
  const { raw, replies } = rawInteraction();
  const interaction = hubInteraction(raw as unknown as Interaction)!;
  expect(interaction).toMatchObject({ guildId: "100", userId: raw.user.id, kind: "command", action: "setup", values: [] });
  await interaction.defer(); await interaction.edit({ content: "saved", controls: [] });
  expect(replies).toEqual([{ flags: MessageFlags.Ephemeral }, { content: "saved", components: [], allowedMentions: { parse: [], repliedUser: false } }]);
  raw.commandName = "unrelated";
  expect(hubInteraction(raw as unknown as Interaction)).toBeUndefined();
});

test("adapter forwards guild removal and hub interactions, and unsubscribes both", async () => {
  const client = new Client(clientOptions);
  const gateway = new DiscordGateway(client);
  const guilds: string[] = [];
  const interactions: HubInteraction[] = [];
  const unsubscribe = gateway.subscribe({ connected: () => {}, disconnected: () => {}, reconnecting: () => {},
    message: () => {}, error: () => {}, fatal: () => {}, guildDelete: id => guilds.push(id), interaction: i => interactions.push(i) });
  const { raw } = rawInteraction();
  try {
    client.emit(Events.GuildDelete, { id: "100" } as never);
    client.emit(Events.InteractionCreate, raw as unknown as Interaction);
    expect(guilds).toEqual(["100"]); expect(interactions).toHaveLength(1);
    unsubscribe();
    client.emit(Events.GuildDelete, { id: "100" } as never);
    client.emit(Events.InteractionCreate, raw as unknown as Interaction);
    expect(guilds).toEqual(["100"]); expect(interactions).toHaveLength(1);
  } finally { await gateway.stop(); }
});

test("channel validation rejects cross-guild, non-text, and insufficient permissions without REST", async () => {
  const client = new Client(clientOptions);
  let channel: Record<string, unknown> | null;
  const original = client.channels.fetch;
  client.channels.fetch = (async () => channel) as unknown as typeof client.channels.fetch;
  const guild = { members: { me: { id: "20" }, fetch: async () => ({ id: "30" }) } };
  const valid = {
    type: ChannelType.GuildText, guildId: "100", guild,
    permissionsFor: () => ({ has: (_flags: bigint[]) => true }),
  };
  try {
    channel = valid;
    await validateHubChannels(client, "100", ["10", "11"], "read", "30");
    await validateHubChannels(client, "100", ["12"], "notify", "30");
    channel = { ...valid, guildId: "200" };
    await expect(validateHubChannels(client, "100", ["10"], "read", "30")).rejects.toThrow("this guild");
    channel = { ...valid, type: ChannelType.GuildVoice };
    await expect(validateHubChannels(client, "100", ["10"], "read", "30")).rejects.toThrow("this guild");
    channel = { ...valid, permissionsFor: (member: unknown) => ({ has: (flags: bigint[]) =>
      (member as { id: string }).id === "30" || !Array.isArray(flags) || !flags.includes(PermissionFlagsBits.ReadMessageHistory) }) };
    await expect(validateHubChannels(client, "100", ["10"], "read", "30")).rejects.toThrow("permissions");
    channel = { ...valid, permissionsFor: (member: unknown) => ({ has: (flags: bigint[]) =>
      (member as { id: string }).id === "30" || !Array.isArray(flags) || !flags.includes(PermissionFlagsBits.SendMessages) }) };
    await expect(validateHubChannels(client, "100", ["10"], "notify", "30")).rejects.toThrow("permissions");
    channel = null;
    await expect(validateHubChannels(client, "100", ["10"], "read", "30")).rejects.toThrow("this guild");
  } finally { client.channels.fetch = original; await client.destroy(); }
});

test("slash registration uses the existing client command manager only after ready", async () => {
  const client = new Client(clientOptions);
  const gateway = new DiscordGateway(client);
  const registered: unknown[] = [];
  Object.defineProperty(client, "application", { value: { commands: { create: async (command: unknown) => { registered.push(command); } } } });
  gateway.subscribe({ connected: () => {}, disconnected: () => {}, reconnecting: () => {}, message: () => {}, error: () => {}, fatal: () => {}, interaction: () => {} });
  try {
    expect(registered).toEqual([]);
    client.emit(Events.ClientReady, client as Client<true>);
    expect(registered).toEqual([hubCommand.toJSON()]);
  } finally { await gateway.stop(); }
});

test("read channel validation requires the actor's effective history permission", async () => {
  const client = new Client(clientOptions);
  const bot = { id: "20" };
  const actor = { id: "30" };
  const fetched: unknown[] = [];
  const original = client.channels.fetch;
  let actorCanView = false;
  let actorCanReadHistory = false;
  let purpose: "read" | "notify" = "read";
  client.channels.fetch = (async () => ({
    type: ChannelType.GuildText, guildId: "100",
    guild: { members: { me: bot, fetch: async (options: unknown) => { fetched.push(options); return actor; } } },
    permissionsFor: (member: unknown) => ({ has: (flags: bigint | bigint[]) => {
      if (member === bot) return true;
      expect(member).toBe(actor);
      const requested = Array.isArray(flags) ? flags : [flags];
      expect(requested).toEqual(purpose === "read"
        ? [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory]
        : [PermissionFlagsBits.ViewChannel]);
      return requested.every(flag => flag === PermissionFlagsBits.ViewChannel ? actorCanView
        : flag === PermissionFlagsBits.ReadMessageHistory && actorCanReadHistory);
    } }),
  })) as unknown as typeof client.channels.fetch;
  try {
    await expect(validateHubChannels(client, "100", ["10"], "read", actor.id)).rejects.toThrow("User cannot access");
    actorCanView = true;
    await expect(validateHubChannels(client, "100", ["10"], "read", actor.id)).rejects.toThrow("User cannot access");
    actorCanReadHistory = true;
    await validateHubChannels(client, "100", ["10"], "read", actor.id);
    purpose = "notify";
    actorCanReadHistory = false;
    await validateHubChannels(client, "100", ["10"], "notify", actor.id);
    expect(fetched).toEqual(Array(4).fill({ user: actor.id, force: true }));
  } finally { client.channels.fetch = original; await client.destroy(); }
});


test("components update the source message and send stale replies ephemerally", async () => {
  for (const kind of ["string", "channel", "button"]) {
    const calls: unknown[] = [];
    const raw = {
      guildId: "100", user: { id: "123456789012345678" }, customId: "hub:token:community", values: ["1"],
      isChatInputCommand: () => false, isStringSelectMenu: () => kind === "string",
      isChannelSelectMenu: () => kind === "channel", isButton: () => kind === "button",
      deferReply: async () => { throw new Error("Components must update their source message"); },
      deferUpdate: async () => { calls.push("update"); }, editReply: async (view: unknown) => { calls.push(view); },
      followUp: async (view: unknown) => { calls.push(view); },
    };
    const interaction = hubInteraction(raw as unknown as Interaction)!;
    await interaction.defer(); await interaction.edit({ content: "next", controls: [] });
    await interaction.followUp({ content: "このメニューは古くなりました。", controls: [] });
    expect(calls).toEqual(["update", { content: "next", components: [], allowedMentions: { parse: [], repliedUser: false } },
      { content: "このメニューは古くなりました。", components: [], allowedMentions: { parse: [], repliedUser: false }, flags: MessageFlags.Ephemeral }]);
  }
});

test("review buttons in DM and guild defer privately without changing the notification", async () => {
  for (const guildId of [null, "100"]) {
    const calls: unknown[] = [];
    const raw = {
      guildId, user: { id: "123456789012345678" }, customId: "hub-review:00000000-0000-0000-0000-000000000000:approved",
      isChatInputCommand: () => false, isStringSelectMenu: () => false, isChannelSelectMenu: () => false, isButton: () => true,
      deferReply: async (options: unknown) => { calls.push(options); },
      deferUpdate: async () => { throw new Error("Must not edit notification"); },
      editReply: async (options: unknown) => { calls.push(options); }, followUp: async () => {},
    };
    const interaction = hubInteraction(raw as unknown as Interaction)!;
    expect(interaction.guildId).toBe(guildId);
    await interaction.defer(); await interaction.edit({ content: "主催者ではありません。", controls: [] });
    expect(calls).toEqual([{ flags: MessageFlags.Ephemeral },
      { content: "主催者ではありません。", components: [], allowedMentions: { parse: [], repliedUser: false } }]);
  }
});

test("edit button opens the hub URL and notification transports suppress all mentions", async () => {
  const client = new Client(clientOptions);
  const gateway = new DiscordGateway(client);
  const sent: unknown[] = [];
  const users: string[] = [];
  const view = { content: "承認待ち", controls: [{ type: "buttons" as const, buttons: [
    { id: "hub-review:token:approved", label: "承認" },
    { url: "https://example.invalid/event/detail/42/update/", label: "直す" },
  ] }] };
  const payload = discordHubView(view);
  expect(payload.components[0]!.toJSON().components[1]).toMatchObject({ style: 5, url: "https://example.invalid/event/detail/42/update/" });
  let guildId = "100";
  client.channels.fetch = (async () => ({ type: ChannelType.GuildText, get guildId() { return guildId; },
    send: async (message: unknown) => { sent.push(message); } })) as unknown as typeof client.channels.fetch;
  client.users.fetch = (async (id: string) => { users.push(id); return { send: async (message: unknown) => { sent.push(message); } }; }) as unknown as typeof client.users.fetch;
  try {
    await gateway.notify("100", { type: "channel", channelId: "11" }, view, "nonce-1");
    await gateway.notify("100", { type: "dm", userId: "123456789012345678" }, view, "nonce-2");
    expect(users).toEqual(["123456789012345678"]);
    expect(sent).toHaveLength(2);
    for (const message of sent) expect(message).toMatchObject({ allowedMentions: { parse: [], repliedUser: false }, enforceNonce: true });
    guildId = "200";
    await expect(gateway.notify("100", { type: "channel", channelId: "11" }, view, "nonce-3")).rejects.toThrow("configured guild");
    expect(sent).toHaveLength(2);
  } finally { await gateway.stop(); }
});
