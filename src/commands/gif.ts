import { 
  SlashCommandBuilder, 
  PermissionFlagsBits, 
  MessageFlags, 
  type ChatInputCommandInteraction 
} from 'discord.js';
import { gifService } from '../services/gif';
import { getCommandResponse } from '../services/prompts';
import type { Command } from '../bot/client';

export const data = new SlashCommandBuilder()
  .setName('gif')
  .setDescription('Configure GIF reactions from the bot')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((sub) =>
    sub.setName('enable').setDescription('Enable GIF reactions in this server')
  )
  .addSubcommand((sub) =>
    sub.setName('disable').setDescription('Disable GIF reactions in this server')
  )
  .addSubcommand((sub) =>
    sub.setName('status').setDescription('Check if GIF reactions are enabled')
  );

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const subcommand = interaction.options.getSubcommand();
  const guildId = interaction.guildId || 'dm';

  if (subcommand === 'enable') {
    gifService.setGifEnabled(guildId, true);
    const msg = getCommandResponse('gif_enabled') || 'GIF reactions enabled!';
    await interaction.reply({ content: msg, flags: MessageFlags.Ephemeral });
  } else if (subcommand === 'disable') {
    gifService.setGifEnabled(guildId, false);
    const msg = getCommandResponse('gif_disabled') || 'GIF reactions disabled.';
    await interaction.reply({ content: msg, flags: MessageFlags.Ephemeral });
  } else if (subcommand === 'status') {
    const isEnabled = gifService.isGifEnabled(guildId);
    const msg = isEnabled
      ? (getCommandResponse('gif_status_enabled') || 'GIF reactions are enabled.')
      : (getCommandResponse('gif_status_disabled') || 'GIF reactions are disabled.');
    await interaction.reply({ content: msg, flags: MessageFlags.Ephemeral });
  }
}

export const command: Command = {
  data,
  execute,
};

export default command;
