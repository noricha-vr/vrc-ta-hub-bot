import { Client, Events, GatewayIntentBits, PermissionFlagsBits, type ClientOptions, type Message } from "discord.js";
import type { Gateway, GatewayEvents, GatewayMessage, HistoryQuery } from "./gateway";

export const clientOptions: ClientOptions = {
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  allowedMentions: { parse: [], repliedUser: false },
  shards: [0],
  shardCount: 1,
  rest: { timeout: 15000, retries: 3 },
};

function toMessage(message: Message): GatewayMessage {
  return {
    id: message.id, channelId: message.channelId, authorId: message.author.id,
    content: message.content, createdAt: message.createdAt.toISOString(),
  };
}

export class DiscordGateway implements Gateway {
  private readonly client: Client;

  constructor(client = new Client(clientOptions)) {
    this.client = client;
  }

  subscribe(events: GatewayEvents): () => void {
    let ready = false;
    const onReady = () => { ready = true; events.connected(); };
    const onShardReady = () => { if (ready) events.connected(); };
    const onResume = () => events.connected();
    const onDisconnect = () => events.disconnected();
    const onReconnecting = () => events.reconnecting();
    const onMessage = (message: Message) => { if (message.inGuild()) events.message(toMessage(message)); };
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
