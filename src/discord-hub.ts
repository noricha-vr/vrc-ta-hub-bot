import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelSelectMenuBuilder, ChannelType,
  MessageFlags, PermissionFlagsBits, SlashCommandBuilder, StringSelectMenuBuilder,
  type Client, type Interaction,
} from "discord.js";
import type { HubInteraction, HubView } from "./hub-setup";

export const hubCommand = new SlashCommandBuilder().setName("hub").setDescription("ハブ連携の設定")
  .setDMPermission(false)
  .addSubcommand(c => c.setName("setup").setDescription("集会・応募チャンネル・通知先を設定"))
  .addSubcommand(c => c.setName("status").setDescription("設定と最近の下書きを確認"))
  .addSubcommand(c => c.setName("pause").setDescription("集会の読み取りを一時停止"))
  .addSubcommand(c => c.setName("leave").setDescription("集会の設定と未承認の下書きを削除して退出"));

export function discordHubView(view: HubView) {
  const components = view.controls.map(control => {
    if (control.type === "channels") return new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(
      new ChannelSelectMenuBuilder().setCustomId(control.id).setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setMinValues(1).setMaxValues(control.multiple ? 25 : 1),
    );
    if (control.type === "select") return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder().setCustomId(control.id).setMinValues(1).setMaxValues(1).addOptions(control.options),
    );
    return new ActionRowBuilder<ButtonBuilder>().addComponents(control.buttons.map(button =>
      new ButtonBuilder().setCustomId(button.id).setLabel(button.label).setStyle(ButtonStyle.Secondary)));
  });
  return { content: view.content, components, allowedMentions: { parse: [] as never[], repliedUser: false } };
}

export function hubInteraction(interaction: Interaction): HubInteraction | undefined {
  const command = interaction.isChatInputCommand() && interaction.commandName === "hub";
  const component = (interaction.isStringSelectMenu() || interaction.isChannelSelectMenu() || interaction.isButton())
    && interaction.customId.startsWith("hub:");
  if (!command && !component) return;
  // Narrow again to keep the Discord interaction boundary fully typed.
  if (!(interaction.isChatInputCommand() || interaction.isStringSelectMenu() || interaction.isChannelSelectMenu() || interaction.isButton())) return;
  return {
    guildId: interaction.guildId, userId: interaction.user.id,
    kind: command ? "command" : "component",
    action: interaction.isChatInputCommand() ? interaction.options.getSubcommand() : interaction.customId,
    values: interaction.isStringSelectMenu() || interaction.isChannelSelectMenu() ? interaction.values : [],
    defer: async () => {
      if (interaction.isChatInputCommand()) await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      else await interaction.deferUpdate();
    },
    edit: async view => { await interaction.editReply(discordHubView(view)); },
    followUp: async view => { await interaction.followUp({ ...discordHubView(view), flags: MessageFlags.Ephemeral }); },
  };
}

export async function validateHubChannels(client: Client, guildId: string, channelIds: string[], purpose: "read" | "notify", userId: string): Promise<void> {
  for (const id of channelIds) {
    if (!/^[0-9]{1,20}$/.test(id)) throw new Error("Invalid channel ID");
    const channel = await client.channels.fetch(id);
    if (!channel || (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement) || channel.guildId !== guildId) {
      throw new Error("Channel must belong to this guild");
    }
    const member = await channel.guild.members.fetch({ user: userId, force: true });
    const userRequired = purpose === "read"
      ? [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory]
      : [PermissionFlagsBits.ViewChannel];
    if (!channel.permissionsFor(member)?.has(userRequired)) throw new Error("User cannot access channel");
    const me = channel.guild.members.me ?? await channel.guild.members.fetchMe();
    const required = purpose === "read"
      ? [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory]
      : [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages];
    if (!channel.permissionsFor(me)?.has(required)) throw new Error("Missing channel permissions");
  }
}
