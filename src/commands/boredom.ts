import { SlashCommandBuilder, ChatInputCommandInteraction, PermissionFlagsBits, MessageFlags } from 'discord.js';
import { boredomService, getRandomBoredomMessage } from '../services/boredom';
import { getCommandResponse } from '../services/prompts';
import type { Command } from '../bot/client';

const boredomCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('boredom')
    .setDescription('Manage Lumia\'s boredom ping settings')
    .setDefaultMemberPermissions(PermissionFlagsBits.SendMessages)
    .addSubcommand(subcommand =>
      subcommand
        .setName('status')
        .setDescription('Check your boredom ping status')
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('enable')
        .setDescription('Allow Lumia to ping you when she\'s bored (10-60 min after last chat)')
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('disable')
        .setDescription('Stop Lumia from pinging you when she\'s bored')
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('stats')
        .setDescription('View detailed boredom statistics')
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('preview')
        .setDescription('Preview a boredom message (see what you\'ll get pinged with)')
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('guild-stats')
        .setDescription('View boredom stats for all users in this server (admin only)')
    ) as SlashCommandBuilder,

  async execute(interaction: ChatInputCommandInteraction) {
    const subcommand = interaction.options.getSubcommand();
    const userId = interaction.user.id;
    const guildId = interaction.guildId || 'dm';
    const username = interaction.user.username;

    switch (subcommand) {
      case 'status': {
        const stats = boredomService.getStats(userId, guildId);
        const status = stats.enabled ? '✅ **ENABLED**' : '❌ **DISABLED**';
        const nextPing = stats.nextPingAt 
          ? `<t:${Math.floor(new Date(stats.nextPingAt).getTime() / 1000)}:R>`
          : 'Not scheduled';
        
        await interaction.reply({
          content: `😴 **Boredom Ping Status for ${username}**

**Status:** ${status}
**Total Pings Received:** ${stats.pingCount}
**Last Interaction:** <t:${Math.floor(new Date(stats.lastInteraction).getTime() / 1000)}:R>
**Next Ping:** ${stats.enabled ? nextPing : 'N/A (disabled)'}

${stats.enabled 
  ? '*I\'ll randomly ping you 10-60 minutes after our last conversation when I get bored~* (=^･ω･^=)' 
  : '*I\'ll leave you alone... for now...* (=･ω･=)'}
`,
          flags: MessageFlags.Ephemeral,
        });
        break;
      }

      case 'enable': {
        const wasEnabled = boredomService.isEnabled(userId, guildId);
        boredomService.optIn(userId, guildId);
        
        if (wasEnabled) {
          const alreadyEnabledResponse = getCommandResponse('boredom_already_enabled') || 
            'You are already opted in to boredom pings!';
          await interaction.reply({
            content: alreadyEnabledResponse,
            flags: MessageFlags.Ephemeral,
          });
        } else {
          const enableResponse = getCommandResponse('boredom_enabled_confirm') || 
            'Boredom pings enabled! I will message you randomly 10-60 minutes after you stop chatting.';
          await interaction.reply({
            content: enableResponse,
            flags: MessageFlags.Ephemeral,
          });
        }
        break;
      }

      case 'disable': {
        const wasEnabled = boredomService.isEnabled(userId, guildId);
        boredomService.optOut(userId, guildId);
        
        if (!wasEnabled) {
          const alreadyDisabledResponse = getCommandResponse('boredom_already_disabled') || 
            'You are already opted out of boredom pings.';
          await interaction.reply({
            content: alreadyDisabledResponse,
            flags: MessageFlags.Ephemeral,
          });
        } else {
          const disableResponse = getCommandResponse('boredom_disabled_confirm') || 
            'Boredom pings disabled. I will no longer message you randomly.';
          await interaction.reply({
            content: disableResponse,
            flags: MessageFlags.Ephemeral,
          });
        }
        break;
      }

      case 'stats': {
        const stats = boredomService.getStats(userId, guildId);
        const settings = boredomService.getSettings(userId, guildId);
        
        await interaction.reply({
          content: `📊 **Detailed Boredom Stats for ${username}**

**Settings:**
• Enabled: ${stats.enabled ? 'Yes' : 'No'}
• First Interaction: ${settings.lastInteractionAt ? `<t:${Math.floor(new Date(settings.lastInteractionAt).getTime() / 1000)}:F>` : 'Never'}

**Activity:**
• Total Pings Received: ${stats.pingCount}
• Last Pinged: ${stats.lastPinged ? `<t:${Math.floor(new Date(stats.lastPinged).getTime() / 1000)}:R>` : 'Never'}
• Last Chat: <t:${Math.floor(new Date(stats.lastInteraction).getTime() / 1000)}:R>

**Current Status:**
• Pending Ping: ${stats.hasPendingPing ? 'Yes ⏰' : 'No'}
${stats.nextPingAt ? `• Next Ping (if enabled): <t:${Math.floor(new Date(stats.nextPingAt).getTime() / 1000)}:R>` : ''}

${stats.enabled 
  ? '_Remember: I get bored 10-60 minutes after we stop talking!_' 
  : '_You\'ve opted out of my random chaos._'}
`,
          flags: MessageFlags.Ephemeral,
        });
        break;
      }

      case 'preview': {
        const previewMessage = getRandomBoredomMessage(userId);
        await interaction.reply({
          content: `👀 **Preview of a Boredom Ping:**

${previewMessage}

_This is an example of what I might send when I get bored! Each message is randomly selected._`,
          flags: MessageFlags.Ephemeral,
        });
        break;
      }

      case 'guild-stats': {
        if (!interaction.guildId) {
          await interaction.reply({
            content: 'This command can only be used in a server!',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const guildUsers = boredomService.listGuildUsers(interaction.guildId);
        
        if (guildUsers.length === 0) {
          await interaction.reply({
            content: 'No users have interacted with Lumia in this server yet!',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const enabledCount = guildUsers.filter(u => u.enabled).length;
        const totalPings = guildUsers.reduce((sum, u) => sum + u.pingCount, 0);
        
        const userList = guildUsers
          .slice(0, 20) // Limit to first 20
          .map(u => {
            const status = u.enabled ? '✅' : '❌';
            return `${status} <@${u.userId}> - ${u.pingCount} pings, last active <t:${Math.floor(new Date(u.lastInteraction).getTime() / 1000)}:R>`;
          })
          .join('\n');

        await interaction.reply({
          content: `📊 **Server Boredom Statistics**

**Summary:**
• Total Users: ${guildUsers.length}
• Enabled Pings: ${enabledCount}
• Disabled Pings: ${guildUsers.length - enabledCount}
• Total Pings Sent: ${totalPings}

**Users:**
${userList}

${guildUsers.length > 20 ? `_...and ${guildUsers.length - 20} more users_` : ''}
`,
          flags: MessageFlags.Ephemeral,
        });
        break;
      }

      default:
        await interaction.reply({
          content: 'Unknown subcommand!',
          flags: MessageFlags.Ephemeral,
        });
    }
  },
};

export default boredomCommand;
