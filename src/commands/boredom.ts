import { SlashCommandBuilder, ChatInputCommandInteraction, MessageFlags } from 'discord.js';
import { boredomService } from '../services/boredom';
import { config } from '../utils/config';
import { canRunPrivilegedCommand } from '../utils/permissions';
import type { Command } from '../bot/client';

const boredomCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('boredom')
    .setDescription('Manage Lumia\'s spontaneous channel chatter engine')
    .addSubcommand((subcommand) =>
      subcommand
        .setName('status')
        .setDescription('View current spontaneous chatter configuration and schedule (Mod Only)')
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('enable')
        .setDescription('Enable spontaneous channel chatter (Mod Only)')
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('disable')
        .setDescription('Disable/pause spontaneous channel chatter (Mod Only)')
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('interval')
        .setDescription('Set minimum and maximum intervals for spontaneous chatter (Mod Only)')
        .addIntegerOption((opt) =>
          opt
            .setName('min')
            .setDescription('Minimum interval in minutes')
            .setRequired(true)
            .setMinValue(1)
        )
        .addIntegerOption((opt) =>
          opt
            .setName('max')
            .setDescription('Maximum interval in minutes')
            .setRequired(true)
            .setMinValue(1)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('trigger')
        .setDescription('Force an immediate spontaneous chatter turn in a random configured channel (Mod Only)')
    ) as SlashCommandBuilder,

  async execute(interaction: ChatInputCommandInteraction) {
    // Gates every subcommand, including `interval` and `trigger`, which write
    // global state. Guild owner / admin permissions were removed deliberately:
    // see canRunPrivilegedCommand.
    if (!canRunPrivilegedCommand(interaction.user.id, interaction.member)) {
      await interaction.reply({
        content: '❌ You must be the bot owner or hold a trusted role to use this command.',
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
**Interval Range:** ${state.minIntervalMinutes} – ${state.maxIntervalMinutes} minutes
**Show Typing Indicator:** ${config.boredom.showTyping ? 'Yes' : 'No (stealth)'}
**Context History Limit:** ${config.boredom.historyLimit} messages
**Configured Channels:** ${channelsFormatted}

**Last Run:** ${lastRunFormatted}
**Next Scheduled Run:** ${nextRunFormatted}`,
          flags: MessageFlags.Ephemeral,
        });
        break;
      }

      case 'interval': {
        const min = interaction.options.getInteger('min', true);
        const max = interaction.options.getInteger('max', true);

        if (min > max) {
          await interaction.reply({
            content: '❌ Minimum interval cannot be greater than maximum interval.',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        boredomService.setIntervals(min, max);
        const state = boredomService.getState();
        const nextRunFormatted = state.nextRunAt && state.enabled
          ? `<t:${Math.floor(new Date(state.nextRunAt).getTime() / 1000)}:R>`
          : 'Not scheduled';

        await interaction.reply({
          content: `⏱️ Spontaneous chatter interval updated to **${min} – ${max} minutes**!\nNext run scheduled for: ${nextRunFormatted}`,
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