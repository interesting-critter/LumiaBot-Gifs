import { SlashCommandBuilder, ChatInputCommandInteraction, PermissionFlagsBits, MessageFlags } from 'discord.js';
import { rateLimiterService } from '../services/rate-limiter';
import { config } from '../utils/config';
import type { Command } from '../bot/client';

const rateLimitCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('ratelimit')
    .setDescription('Manage bot chat rate limiting (Mod Only)')
    .addSubcommand((subcommand) =>
      subcommand
        .setName('status')
        .setDescription('View current rate limit configuration (Mod Only)')
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('set')
        .setDescription('Set rate limit window in seconds (Mod Only)')
        .addIntegerOption((opt) =>
          opt
            .setName('seconds')
            .setDescription('Rate limit window in seconds (1+)')
            .setRequired(true)
            .setMinValue(1)
        )
    ) as SlashCommandBuilder,

  async execute(interaction: ChatInputCommandInteraction) {
    const isOwner = interaction.user.id === config.bot.ownerId;
    const isServerOwner = interaction.guild?.ownerId === interaction.user.id;
    const hasAdminOrBanPerms = Boolean(
      interaction.memberPermissions?.has(PermissionFlagsBits.BanMembers) ||
      interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)
    );

    if (!isOwner && !isServerOwner && !hasAdminOrBanPerms) {
      await interaction.reply({
        content: '❌ You must be the bot owner or a mod to use this command.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const subcommand = interaction.options.getSubcommand();

    switch (subcommand) {
      case 'status': {
        const seconds = rateLimiterService.getLimitSeconds();
        const exemptRoles = rateLimiterService.getExemptRoles();
        const exemptFormatted = exemptRoles.length > 0
          ? exemptRoles.map((r) => `\`${r}\``).join(', ')
          : '_None configured (set RATE_LIMIT_EXEMPT_ROLES)_';

        await interaction.reply({
          content: `⏱️ **Rate Limiting Status**

**Window:** ${seconds} second(s) per request
**Max Requests:** 1 per window
**Exempt Roles:** ${exemptFormatted}
**Owner Exempt:** Yes`,
          flags: MessageFlags.Ephemeral,
        });
        break;
      }

      case 'set': {
        const seconds = interaction.options.getInteger('seconds', true);
        rateLimiterService.setLimitSeconds(seconds);

        await interaction.reply({
          content: `⏱️ Rate limit window updated to **${seconds} second(s)**!`,
          flags: MessageFlags.Ephemeral,
        });
        break;
      }

      default: {
        await interaction.reply({
          content: 'Unknown subcommand.',
          flags: MessageFlags.Ephemeral,
        });
      }
    }
  },
};

export default rateLimitCommand;
