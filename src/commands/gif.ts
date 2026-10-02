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
  // Deliberately NOT ManageGuild: the read-only `status` subcommand stays
  // available to everyone who can talk, and the mutating subcommands are
  // gated at runtime below. Discord has no per-subcommand permission gate, so
  // raising this would hide `status` from ordinary members too.
  .setDefaultMemberPermissions(PermissionFlagsBits.SendMessages)
  .addSubcommand((sub) =>
    sub.setName('enable').setDescription('Enable GIF reactions in this server (Manage Server)')
  )
  .addSubcommand((sub) =>
    sub.setName('disable').setDescription('Disable GIF reactions in this server (Manage Server)')
  )
  .addSubcommand((sub) =>
    sub.setName('status').setDescription('Check if GIF reactions are enabled')
  );

/**
 * `enable`/`disable` write `gif_settings` for the whole guild, so they require
 * `ManageGuild`. Previously the only gate was `setDefaultMemberPermissions(
 * SendMessages)`, i.e. any member who could talk could flip the server-wide
 * behaviour flag — including turning it back on in a server where a moderator
 * had deliberately disabled it.
 *
 * Fails closed: a missing permission object (an unusual raw shape) is treated
 * as "not permitted" rather than skipping the check.
 */
function canManageGifSettings(interaction: ChatInputCommandInteraction): boolean {
  const permissions = interaction.memberPermissions;
  if (!permissions) return false;
  return permissions.has(PermissionFlagsBits.ManageGuild);
}

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const subcommand = interaction.options.getSubcommand();
  const guildId = interaction.guildId || 'dm';

  if (subcommand === 'enable' || subcommand === 'disable') {
    if (!canManageGifSettings(interaction)) {
      await interaction.reply({
        content: '❌ You need the **Manage Server** permission to change GIF reaction settings for this server.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  }

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
