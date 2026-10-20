import { Client, ChannelType, Events, GatewayIntentBits, MessageFlags, Options, PermissionFlagsBits, type ClientOptions, type Message, type Guild, type Interaction } from "discord.js";
import type { NotificationTarget } from "./hub-store";
import type { HubView } from "./hub-setup";
import { discordHubView, hubCommand, hubInteraction, validateHubChannels } from "./discord-hub";
import type { Gateway, GatewayEvents, GatewayMessage, HistoryQuery } from "./gateway";

export const clientOptions: ClientOptions = {
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  allowedMentions: { parse: [], repliedUser: false },
  shards: [0],
  shardCount: 1,
  rest: { timeout: 15000, retries: 3 },
  // 本文は受信箱にだけ持つ。SDK のメッセージキャッシュには残さない。
  makeCache: Options.cacheWithLimits({ ...Options.DefaultMakeCacheSettings, MessageManager: 0 }),
};

const GUILD_PAGE = 200;

function toMessage(message: Message): GatewayMessage {
  return {
    id: message.id, channelId: message.channelId, authorId: message.author.id,
    content: message.content, createdAt: message.createdAt.toISOString(),
    authorDisplayName: message.member?.displayName ?? message.author.displayName,
    sourceUrl: message.url,
    attachments: [...message.attachments.values()].map(attachment => ({
      url: attachment.url, name: attachment.name,
      ...(attachment.contentType ? { contentType: attachment.contentType } : {}),
    })),
  };
}

export class DiscordGateway implements Gateway {
  private readonly client: Client;

  constructor(client = new Client(clientOptions)) {
    this.client = client;
  }

  subscribe(events: GatewayEvents): () => void {
    // ClientReady を受けたか（以後の ShardReady で突合する）と、コマンド登録を済ませたかは分けて持つ。
    // 初回の所属取得が切断で捨てられても、次の ShardReady で取り直せるようにするため。
    let clientReady = false;
    let commandRegistered = false;
    let subscribed = true;
    // 切断・再接続のたびに進める。古い所属取得が後から終わっても、接続済みにしない。
    let generation = 0;
    const current = (mine: number) => subscribed && mine === generation;
    const reconcileReady = async () => {
      const mine = ++generation;
      try {
        const guildIds = events.guildsReady ? await this.allGuildIds() : [...this.client.guilds.cache.keys()];
        if (!current(mine)) return;
        events.guildsReady?.(guildIds);
      } catch { if (current(mine)) events.fatal(); return; }
      if (!current(mine)) return;
      events.connected();
      if (!commandRegistered && events.interaction && this.client.application) {
        // 登録できた時だけ済みにする。失敗したら次の ShardReady でもう一度試す。
        commandRegistered = true;
        void this.client.application.commands.create(hubCommand.toJSON())
          .catch(() => { commandRegistered = false; events.error(); });
      }
    };
    const onReady = () => { clientReady = true; void reconcileReady(); };
    const onShardReady = () => { if (clientReady) void reconcileReady(); };
    const onResume = () => events.connected();
    // discord.js 14 では ShardDisconnect は再接続しない close code（4004 / 4010〜4014 等）の時だけ出る。
    // 同じクライアントでは復帰しないので、終了させて外の監督に再起動させる。
    const onDisconnect = () => { generation++; events.fatal(); };
    const onReconnecting = () => { generation++; events.reconnecting(); };
    const onMessage = (message: Message) => { if (message.inGuild()) events.message(toMessage(message)); };
    const onInteraction = (raw: Interaction) => {
      const interaction = hubInteraction(raw);
      if (interaction) events.interaction?.(interaction);
    };
    const onGuildDelete = (guild: Guild) => events.guildDelete?.(guild.id);
    this.client.on(Events.InteractionCreate, onInteraction);
    this.client.on(Events.GuildDelete, onGuildDelete);
    const onError = () => events.error();
    const onFatal = () => events.fatal();
    this.client.on(Events.ClientReady, onReady);
    this.client.on(Events.ShardReady, onShardReady);
    this.client.on(Events.ShardResume, onResume);
    this.client.on(Events.ShardDisconnect, onDisconnect);
    this.client.on(Events.ShardReconnecting, onReconnecting);
    this.client.on(Events.MessageCreate, onMessage);
    this.client.on(Events.Error, onError);
    this.client.on(Events.ShardError, onError);
    this.client.on(Events.Invalidated, onFatal);
    return () => {
      subscribed = false;
      this.client.off(Events.InteractionCreate, onInteraction);
      this.client.off(Events.GuildDelete, onGuildDelete);
      this.client.off(Events.ClientReady, onReady);
      this.client.off(Events.ShardReady, onShardReady);
      this.client.off(Events.ShardResume, onResume);
      this.client.off(Events.ShardDisconnect, onDisconnect);
      this.client.off(Events.ShardReconnecting, onReconnecting);
      this.client.off(Events.MessageCreate, onMessage);
      this.client.off(Events.Error, onError);
      this.client.off(Events.ShardError, onError);
      this.client.off(Events.Invalidated, onFatal);
    };
  }

  /** 所属サーバーを全ページ取る。1 ページ（200 件）だけで突合すると、残りを退出済みと誤って消す。 */
  private async allGuildIds(): Promise<string[]> {
    const ids: string[] = [];
    let after: string | undefined;
    for (;;) {
      const page = await this.client.guilds.fetch({ limit: GUILD_PAGE, ...(after ? { after } : {}) });
      const keys = [...page.keys()];
      ids.push(...keys);
      if (keys.length < GUILD_PAGE) return ids;
      after = keys.reduce((max, id) => (BigInt(id) > BigInt(max) ? id : max));
    }
  }

  async notify(guildId: string, target: NotificationTarget, view: HubView, nonce: string): Promise<void> {
    const payload = { ...discordHubView(view), nonce, enforceNonce: true, flags: MessageFlags.SuppressEmbeds as const };
    if (target.type === "dm") {
      const user = await this.client.users.fetch(target.userId);
      await user.send(payload);
      return;
    }
    const channel = await this.client.channels.fetch(target.channelId);
    if (!channel || (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement) || channel.guildId !== guildId) {
      throw new Error("Notification channel must belong to configured guild");
    }
    await channel.send(payload);
  }

  /** SDK のキャッシュや短時間の nonce 重複排除に頼らず、自分の通知を照合する。 */
  async findNotification(guildId: string, target: NotificationTarget, nonce: string, buttonId: string): Promise<boolean> {
    const channel = target.type === "dm"
      ? await (await this.client.users.fetch(target.userId)).createDM()
      : await this.client.channels.fetch(target.channelId);
    if (!channel || (channel.type !== ChannelType.DM && channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement)) {
      throw new Error("Invalid notification channel");
    }
    if (target.type === "dm" ? channel.type !== ChannelType.DM : channel.type === ChannelType.DM || channel.guildId !== guildId) {
      throw new Error("Invalid notification channel");
    }
    if (channel.type !== ChannelType.DM) {
      const me = channel.guild.members.me ?? await channel.guild.members.fetchMe();
      if (!channel.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory])) {
        throw new Error("Notification channel lacks history permissions");
      }
    }
    const messages = await channel.messages.fetch({ limit: 100, cache: false });
    return [...messages.values()].some(message => message.author.id === this.client.user?.id
      && (message.nonce === nonce || message.components.some(row => "components" in row
        && row.components.some(component => "customId" in component && component.customId === buttonId))));
  }

  async validateChannels(guildId: string, channelIds: string[], purpose: "read" | "notify", userId: string): Promise<void> {
    await validateHubChannels(this.client, guildId, channelIds, purpose, userId);
  }

  async leaveGuild(guildId: string): Promise<void> {
    const guild = await this.client.guilds.fetch(guildId);
    await guild.leave();
  }

  async start(token: string): Promise<void> {
    await this.client.login(token);
  }

  async stop(): Promise<void> {
    await this.client.destroy();
  }

  async fetchMessages(channelId: string, query: HistoryQuery): Promise<GatewayMessage[]> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel || channel.isDMBased() || !channel.isTextBased()) {
      throw new Error("Selected channel must be a guild text channel");
    }
    // Discord may return an empty page without ReadMessageHistory. Treat that as
    // a failed recovery, rather than falsely acknowledging a complete history.
    const me = channel.guild.members.me;
    const permissions = me && channel.permissionsFor(me);
    if (!permissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory])) {
      throw new Error("Selected channel lacks history permissions");
    }
    const messages = await channel.messages.fetch({ ...query, cache: false });
    return [...messages.values()].map(toMessage);
  }
}
