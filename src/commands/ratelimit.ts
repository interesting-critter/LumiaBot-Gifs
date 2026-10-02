import { SlashCommandBuilder, ChatInputCommandInteraction, MessageFlags } from 'discord.js';
import { rateLimiterService } from '../services/rate-limiter';
import { canRunPrivilegedCommand, getAuthorisedRoleIds } from '../utils/permissions';
import type { Command } from '../bot/client';

const rateLimitCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('ratelimit')
    .setDescription('Manage bot chat rate limiting (Owner or trusted role)')
    .addSubcommand((subcommand) =>
      subcommand
        .setName('status')
        .setDescription('View current rate limit configuration (Owner or trusted role)')
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('set')
        .setDescription('Set rate limit window in seconds (Owner or trusted role). Survives a restart.')
        .addIntegerOption((opt) =>
          opt
            .setName('seconds')
            .setDescription('Rate limit window in seconds (1+)')
            .setRequired(true)
            .setMinValue(1)
        )
    ) as SlashCommandBuilder,

  async execute(interaction: ChatInputCommandInteraction) {
    if (!canRunPrivilegedCommand(interaction.user.id, interaction.member)) {
      await interaction.reply({
        content: '❌ You must be the bot owner or hold a trusted role (by role ID) to use this command.',
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
        // Authorisation is a separate, ID-only list: the exempt list can name
        // roles, the trusted list cannot. Showing both keeps the two
        // capabilities distinguishable instead of implying one list.
        const trustedIds = getAuthorisedRoleIds();
        const trustedFormatted = trustedIds.length > 0
          ? trustedIds.map((id) => `\`${id}\``).join(', ')
          : '_None configured (set TRUSTED_ROLE_IDS)_';

        await interaction.reply({
          content: `⏱️ **Rate Limiting Status**

**Window:** ${seconds} second(s) per request
**Max Requests:** 1 per window
**Rate-Limit Exempt:** ${exemptFormatted}
**Privileged Command Roles:** ${trustedFormatted}
**Owner Exempt:** Yes

_Only role **IDs** grant \`/ratelimit\` and \`/boredom\`; the exempt list above may also use role names, which bypass rate limiting only._`,
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
