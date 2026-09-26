import { SlashCommandBuilder, ChatInputCommandInteraction, PermissionFlagsBits, MessageFlags } from 'discord.js';
import { boredomService } from '../services/boredom';
import { config } from '../utils/config';
import type { Command } from '../bot/client';

const boredomCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('boredom')
    .setDescription('Manage Lumia\'s spontaneous channel chatter engine')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((subcommand) =>
      subcommand
        .setName('status')
        .setDescription('View current spontaneous chatter configuration and schedule')
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('enable')
        .setDescription('Enable spontaneous channel chatter')
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('disable')
        .setDescription('Disable/pause spontaneous channel chatter')
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('trigger')
        .setDescription('Force an immediate spontaneous chatter turn in a random configured channel')
    ) as SlashCommandBuilder,

  async execute(interaction: ChatInputCommandInteraction) {
    const isOwner = interaction.user.id === config.bot.ownerId;
    const isServerOwner = interaction.guild?.ownerId === interaction.user.id;
    const hasModPerms = interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ||
      interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);

    if (!isOwner && !isServerOwner && !hasModPerms) {
      await interaction.reply({
        content: '❌ You must have `Manage Server` permissions or be the bot owner to use this command.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const subcommand = interaction.options.getSubcommand();

    switch (subcommand) {
      case 'status': {
        const state = boredomService.getState();
        const statusText = state.enabled ? '✅ **ENABLED**' : '❌ **DISABLED**';
        const channelsFormatted = config.boredom.channelIds.length > 0
          ? config.boredom.channelIds.map((id) => `<#${id}> (\`${id}\`)`).join(', ')
          : '_None configured (set BOREDOM_CHANNELS)_';

        const lastRunFormatted = state.lastRunAt
          ? `<t:${Math.floor(new Date(state.lastRunAt).getTime() / 1000)}:R>`
          : 'Never';

        const nextRunFormatted = state.nextRunAt && state.enabled
          ? `<t:${Math.floor(new Date(state.nextRunAt).getTime() / 1000)}:R>`
          : 'Not scheduled';

        await interaction.reply({
          content: `😴 **Spontaneous Chatter System Status**

**Status:** ${statusText}
**Interval Range:** ${config.boredom.minIntervalMinutes} – ${config.boredom.maxIntervalMinutes} minutes
**Show Typing Indicator:** ${config.boredom.showTyping ? 'Yes' : 'No (stealth)'}
**Context History Limit:** ${config.boredom.historyLimit} messages
**Configured Channels:** ${channelsFormatted}

**Last Run:** ${lastRunFormatted}
**Next Scheduled Run:** ${nextRunFormatted}`,
          flags: MessageFlags.Ephemeral,
        });
        break;
      }

      case 'enable': {
        boredomService.setEnabled(true);
        await interaction.reply({
          content: '✅ Spontaneous channel chatter has been **enabled** and scheduled!',
          flags: MessageFlags.Ephemeral,
        });
        break;
      }

      case 'disable': {
        boredomService.setEnabled(false);
        await interaction.reply({
          content: '⏸️ Spontaneous channel chatter has been **disabled** and pending timers cancelled.',
          flags: MessageFlags.Ephemeral,
        });
        break;
      }

      case 'trigger': {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const success = await boredomService.executeSpontaneousChat(interaction.client);
        if (success) {
          await interaction.editReply('✨ Spontaneous chatter message generated and posted!');
        } else {
          await interaction.editReply('⚠️ Spontaneous chatter failed. Check channel configurations and bot permissions.');
        }
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

export default boredomCommand;