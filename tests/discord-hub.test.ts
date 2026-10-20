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
    await expect(validateHubChannels(client, "100", ["10"], "notify", "30")).rejects.toThrow("メッセージを送信");
    channel = null;
    await expect(validateHubChannels(client, "100", ["10"], "read", "30")).rejects.toThrow("this guild");
  } finally { client.channels.fetch = original; await client.destroy(); }
});

test("通知先の取得が null なら編集を終了できる Unknown Channel として返す", async () => {
  const client = new Client(clientOptions);
  const gateway = new DiscordGateway(client);
  client.channels.fetch = (async () => null) as unknown as typeof client.channels.fetch;
  try {
    await expect(gateway.editNotification({ channelId: "11", messageId: "501" }, "承認済み"))
      .rejects.toMatchObject({ code: 10003, status: 404 });
  } finally { await gateway.stop(); }
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
    send: async (message: unknown) => { sent.push(message); return { channelId: "11", id: "501" }; } })) as unknown as typeof client.channels.fetch;
  client.users.fetch = (async (id: string) => { users.push(id); return { send: async (message: unknown) => { sent.push(message); return { channelId: "900", id: "502" }; } }; }) as unknown as typeof client.users.fetch;
  try {
    expect(await gateway.notify("100", { type: "channel", channelId: "11" }, view, "nonce-1"))
      .toEqual({ channelId: "11", messageId: "501" });
    expect(await gateway.notify("100", { type: "dm", userId: "123456789012345678" }, view, "nonce-2"))
      .toEqual({ channelId: "900", messageId: "502" });
    expect(users).toEqual(["123456789012345678"]);
    expect(sent).toHaveLength(2);
    for (const message of sent) expect(message).toMatchObject({ allowedMentions: { parse: [], repliedUser: false }, enforceNonce: true,
      flags: MessageFlags.SuppressEmbeds });
    guildId = "200";
    await expect(gateway.notify("100", { type: "channel", channelId: "11" }, view, "nonce-3")).rejects.toThrow("configured guild");
    expect(sent).toHaveLength(2);
  } finally { await gateway.stop(); }
});

for (const target of [{ type: "channel", channelId: "11" }, { type: "dm", userId: "123456789012345678" }] as const)
test(`${target.type} の直近履歴から自分の nonce または通知ボタンを照合する`, async () => {
  const client = new Client(clientOptions);
  const gateway = new DiscordGateway(client);
  Object.defineProperty(client, "user", { value: { id: "20" } });
  const buttonId = "hub-review:101:ignore";
  const queries: unknown[] = [];
  const users: string[] = [];
  const channels: string[] = [];
  let messages: unknown[] = [];
  let historyAllowed = true;
  let guildId = "100";
  let historyDown = false;
  let dmOpened = 0;
  const channel = {
    id: target.type === "dm" ? "900" : "11",
    type: target.type === "dm" ? ChannelType.DM : ChannelType.GuildText,
    get guildId() { return guildId; },
    guild: { members: { me: { id: "20" } } },
    permissionsFor: () => ({ has: () => historyAllowed }),
    messages: { fetch: async (query: unknown) => {
      queries.push(query);
      if (historyDown) throw new Error("Synthetic history failure");
      return new Map(messages.map((message, i) => [String(i), message]));
    } },
  };
  client.channels.fetch = (async (id: string) => { channels.push(id); return channel; }) as unknown as typeof client.channels.fetch;
  client.users.fetch = (async (id: string) => {
    users.push(id);
    return { createDM: async () => { dmOpened++; return channel; } };
  }) as unknown as typeof client.users.fetch;
  const own = (nonce: string | null, customId?: string) => ({ id: "501", author: { id: "20" }, nonce,
    components: customId ? [{ components: [{ customId }] }] : [] });
  const find = () => gateway.findNotification("100", target, "nonce-1", buttonId);
  try {
    messages = [own("nonce-1")]; expect(await find()).toEqual({ channelId: channel.id, messageId: "501" });
    messages = [own(null, buttonId)]; expect(await find()).toEqual({ channelId: channel.id, messageId: "501" });
    messages = [{ ...own("nonce-1", buttonId), author: { id: "30" } }, own("other", "hub-review:102:ignore")];
    expect(await find()).toBe(false);
    messages = []; expect(await find()).toBe(false);
    expect(queries).toEqual(Array(4).fill({ limit: 100, cache: false }));
    if (target.type === "dm") {
      expect(users).toEqual(Array(4).fill(target.userId)); expect(dmOpened).toBe(4); expect(channels).toEqual([]);
    } else {
      expect(channels).toEqual(Array(4).fill(target.channelId)); expect(users).toEqual([]);
      historyAllowed = false; await expect(find()).rejects.toThrow("history permissions");
      historyAllowed = true; guildId = "200"; await expect(find()).rejects.toThrow("Invalid notification channel");
      guildId = "100";
    }
    messages = [own(null, buttonId)];
    expect(await gateway.findNotification("100", target, "old-nonce", buttonId))
      .toEqual({ channelId: channel.id, messageId: "501" });
    historyDown = true; await expect(find()).rejects.toThrow("Synthetic history failure");
  } finally { await gateway.stop(); }
});

for (const channelType of [ChannelType.GuildText, ChannelType.DM])
for (const result of ["承認済み（運営 ＠everyone）", "却下（運営）", "承認済み", "却下"])
test(`元の通知を編集してリンクだけ残し結果を一行表示する: ${channelType} ${result}`, async () => {
  const client = new Client(clientOptions);
  const gateway = new DiscordGateway(client);
  Object.defineProperty(client, "user", { value: { id: "20" } });
  const original = "承認待ちの発表があります。\n日付：2026-11-03(火)\n発表者：発表者\nテーマ：題名\nhttps://discord.com/channels/100/10/101";
  let content = original;
  let components = discordHubView({ content, controls: [{ type: "buttons", buttons: [
    { id: "hub-review:draft:approved", label: "承認" },
    { url: "https://example.invalid/edit/42", label: "直す" },
    { id: "hub-review:draft:rejected", label: "却下" },
  ] }] }).components;
  const edits: Record<string, unknown>[] = [];
  client.channels.fetch = (async (id: string) => {
    expect(id).toBe("11");
    return { type: channelType, messages: { fetch: async (options: { message: string; cache: boolean }) => {
      expect(options).toEqual({ message: "501", cache: false });
      const received = components.map(row => ({ components: row.toJSON().components.map(c => ({ ...c, toJSON: () => c })) }));
      return { author: { id: "20" }, content, components: received, edit: async (payload: Record<string, unknown>) => {
        edits.push(payload); content = payload.content as string; components = payload.components as typeof components;
      } };
    } } };
  }) as unknown as typeof client.channels.fetch;
  try {
    await gateway.editNotification({ channelId: "11", messageId: "501" }, result);
    // 応答を失って再試行しても結果行を重複させない。
    await gateway.editNotification({ channelId: "11", messageId: "501" }, result);
    expect(content).toBe(`${original}\n${result}`);
    for (const edit of edits) {
      expect(edit.allowedMentions).toEqual({ parse: [], repliedUser: false });
      const rows = edit.components as typeof components;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.toJSON().components).toEqual([
        expect.objectContaining({ style: 5, url: "https://example.invalid/edit/42", label: "直す" }),
      ]);
    }
  } finally { await gateway.stop(); }
});

for (const member of [{ displayName: "サーバー表示名" }, { nick: "ニックネーム" }, null])
test(`通知操作に Discord の表示名と元のメッセージ ID を渡す: ${JSON.stringify(member)}`, () => {
  const raw = {
    guildId: member ? "100" : null, channelId: "11", message: { id: "501" }, member,
    user: { id: "123456789012345678", displayName: "アカウント表示名", username: "account" },
    customId: "hub-review:00000000-0000-0000-0000-000000000000:approved",
    isChatInputCommand: () => false, isStringSelectMenu: () => false, isChannelSelectMenu: () => false, isButton: () => true,
  };
  expect(hubInteraction(raw as unknown as Interaction)).toMatchObject({
    userDisplayName: member && "displayName" in member ? member.displayName : member?.nick ?? "アカウント表示名",
    notification: { channelId: "11", messageId: "501" },
  });
});


test("確認待ちの無視はリンクを含む全ボタンを外し、編集の再試行でも結果を重ねない", async () => {
  const client = new Client(clientOptions);
  const gateway = new DiscordGateway(client);
  Object.defineProperty(client, "user", { value: { id: "20" } });
  const original = "確認が必要な投稿があります。\nhttps://discord.com/channels/100/10/101\n理由：題名を読み取れません。";
  let content = original;
  let components = discordHubView({ content, controls: [{ type: "buttons", buttons: [
    { url: "https://example.invalid/event/apply/1/", label: "Hub で登録する" },
    { id: "hub-review:101:ignore", label: "無視する" },
  ] }] }).components;
  const edits: Record<string, unknown>[] = [];
  client.channels.fetch = (async () => ({ type: ChannelType.GuildText,
    messages: { fetch: async () => ({ author: { id: "20" }, content,
      components: components.map(row => ({ components: row.toJSON().components.map(c => ({ ...c, toJSON: () => c })) })),
      edit: async (payload: Record<string, unknown>) => {
        edits.push(payload); content = payload.content as string; components = payload.components as typeof components;
      } }) },
  })) as unknown as typeof client.channels.fetch;
  try {
    await gateway.editNotification({ channelId: "11", messageId: "501" }, "無視（<@123456789012345678>）", true);
    await gateway.editNotification({ channelId: "11", messageId: "501" }, "無視（<@123456789012345678>）", true);
    expect(content).toBe(`${original}\n無視（<@123456789012345678>）`);
    for (const edit of edits) {
      expect(edit.components).toEqual([]);
      expect(edit.allowedMentions).toEqual({ parse: [], repliedUser: false });
    }
  } finally { await gateway.stop(); }
});
for (const channelType of [ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.DM])
for (const result of ["", "承認済み（運営）", "却下（運営）"])
test(`続報の通知本文だけを更新しボタン・結果・埋め込み抑制を保つ: ${channelType} ${result}`, async () => {
  const client = new Client(clientOptions);
  const gateway = new DiscordGateway(client);
  Object.defineProperty(client, "user", { value: { id: "20" } });
  let content = `元の通知${result ? `\n${result}` : ""}`;
  const edits: Record<string, unknown>[] = [];
  client.channels.fetch = (async () => ({ type: channelType, messages: { fetch: async () => ({
    author: { id: "20" }, content, edit: async (payload: Record<string, unknown>) => {
      edits.push(payload); content = payload.content as string;
    },
  }) } })) as unknown as typeof client.channels.fetch;
  try {
    const view = { content: "最新の通知\n資料：https://example.invalid/slides", controls: [] };
    await gateway.updateNotification({ channelId: "11", messageId: "501" }, view);
    await gateway.updateNotification({ channelId: "11", messageId: "501" }, view);
    expect(content).toBe(`${view.content}${result ? `\n${result}` : ""}`);
    for (const edit of edits) {
      // components を送らないことで、既存のボタンを変更しない。
      expect(edit).not.toHaveProperty("components");
      expect(edit.allowedMentions).toEqual({ parse: [], repliedUser: false });
      expect(edit.flags).toBe(MessageFlags.SuppressEmbeds);
    }
  } finally { await gateway.stop(); }
});

test("続報の編集でも自分の通知以外は変更せず、削除済みチャンネルを終了できる", async () => {
  const client = new Client(clientOptions);
  const gateway = new DiscordGateway(client);
  Object.defineProperty(client, "user", { value: { id: "20" } });
  let edits = 0;
  const view = { content: "最新の通知", controls: [] };
  client.channels.fetch = (async () => ({ type: ChannelType.GuildText, messages: { fetch: async () => ({
    author: { id: "30" }, edit: async () => { edits++; },
  }) } })) as unknown as typeof client.channels.fetch;
  try {
    await expect(gateway.updateNotification({ channelId: "11", messageId: "501" }, view)).rejects.toThrow("this bot");
    expect(edits).toBe(0);
    client.channels.fetch = (async () => null) as unknown as typeof client.channels.fetch;
    await expect(gateway.updateNotification({ channelId: "11", messageId: "501" }, view))
      .rejects.toMatchObject({ code: 10003, status: 404 });
  } finally { await gateway.stop(); }
});
