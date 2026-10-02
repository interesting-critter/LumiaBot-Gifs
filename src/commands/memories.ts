import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, MessageFlags } from 'discord.js';
import { userMemoryService } from '../services/user-memory';
import { getCommandResponse, getErrorMessage } from '../services/prompts';
import { buildAllowedMentions, canRunPrivilegedCommand } from '../utils/permissions';
import { neutralizeMentions } from '../utils/mentions';
import { config } from '../utils/config';
import type { Command } from '../bot/client';

const command: Command = {
  data: new SlashCommandBuilder()
    .setName('memories')
    .setDescription('View users Zakira has formed opinions about')
    .addSubcommand((subcommand) =>
      subcommand
        .setName('list')
        .setDescription('List users Zakira has opinions about in this server (owner or trusted role)')
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('view')
        .setDescription('View Zakira\'s opinion about a specific user in this server (owner or trusted role)')
        .addStringOption((option) =>
          option
            .setName('username')
            .setDescription('Username to look up')
            .setRequired(true)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('clear')
        .setDescription('Clear all memories in every server (owner only)')
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('clear-user')
        .setDescription('Clear stored opinion for a user ID (owner only)')
        .addStringOption((option) =>
          option
            .setName('user-id')
            .setDescription('Discord user ID whose stored opinion should be cleared')
            .setRequired(true)
        )
    ) as SlashCommandBuilder,
  /*
   * Authorisation, in one place, with the two halves doing different jobs.
   *
   * `ownerOnlySubcommands` is checked in `bot/client.ts` *before* `execute()`
   * runs and compares only against `config.bot.ownerId` — a trusted role holder
   * can never reach a subcommand listed there. So:
   *
   *   - `clear` and `clear-user` are listed, because they are cross-guild
   *     erasures ("forget everything" / "forget this person anywhere") and no
   *     per-guild authority should reach them.
   *   - `list` and `view` are NOT listed, because the in-`execute`
   *     `canRunPrivilegedCommand` gate below is the one that also honours
   *     `TRUSTED_ROLE_IDS` — the same gate `/ratelimit` and `/boredom` use.
   *
   * These two used to be listed in BOTH places, which made the role gate dead
   * code: every subcommand was already owner-only by the time `execute` ran, so
   * the "or hold a trusted role" branch could never be taken and the
   * "(Mod Only)" in the subcommand descriptions was a lie.
   *
   * Granting trusted roles `list`/`view` is safe because both reads are
   * guild-scoped: `listUsers(guildId)` and `getOpinionByUsername(username,
   * guildId)` filter on `guild_id`, so a moderator sees only their own server's
   * opinions and cannot read the third-party gossip the bot picked up elsewhere.
   * (A DM collapses to `resolveGuildScope`'s legacy sentinel, which is its own
   * scope — not a cross-guild view.)
   */
  ownerOnlySubcommands: ['clear', 'clear-user'],

  async execute(interaction: ChatInputCommandInteraction) {
    const subcommand = interaction.options.getSubcommand();
    const guildId = interaction.guildId ?? undefined;

    // Defence in depth for the two erasures. `bot/client.ts` already refuses
    // them to anyone but the owner; if a future edit drops them from
    // `ownerOnlySubcommands`, this must not silently become reachable by a
    // trusted role, because the trusted-role gate below would otherwise admit
    // `clear` and wipe every guild.
    if (subcommand === 'clear' || subcommand === 'clear-user') {
      if (!config.bot.ownerIdSet || interaction.user.id !== config.bot.ownerId) {
        await interaction.reply({
          content: '❌ This subcommand is only available to the bot owner.',
          flags: MessageFlags.Ephemeral,
          allowedMentions: buildAllowedMentions(),
        });
        return;
      }
    }

    if (!canRunPrivilegedCommand(interaction.user.id, interaction.member)) {
      await interaction.reply({
        content: '❌ You must be the bot owner or hold a trusted role to use this command.',
        flags: MessageFlags.Ephemeral,
        allowedMentions: buildAllowedMentions(),
      });
      return;
    }

    try {
      if (subcommand === 'list') {
        const users = userMemoryService.listUsers(guildId);

        if (users.length === 0) {
          const noMemoriesResponse = getCommandResponse('no_memories_yet') || 
            "I haven't formed any opinions about users yet. Start chatting with me to build up your memory collection~";
          await interaction.reply({
            content: noMemoriesResponse,
            flags: MessageFlags.Ephemeral,
            allowedMentions: buildAllowedMentions(),
          });
          return;
        }

        const embed = new EmbedBuilder()
          .setTitle('Zakira Has Opinions About')
          .setDescription(`Total: ${users.length} users`)
          .setColor(0xFF69B4)
          .setTimestamp();

        // Group by sentiment
        const sentimentEmojis: Record<string, string> = {
          positive: '😊',
          negative: '😤',
          neutral: '😐',
          mixed: '🤔',
        };

        users.slice(0, 25).forEach((user) => {
          const emoji = sentimentEmojis[user.sentiment] || '💭';
          embed.addFields({
            name: `${emoji} ${user.username}`,
            value: `Sentiment: ${user.sentiment}\nLast updated: ${new Date(user.updatedAt).toLocaleDateString()}`,
            inline: true,
          });
        });

        await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral, allowedMentions: buildAllowedMentions() });

      } else if (subcommand === 'view') {
        const username = interaction.options.getString('username', true);
        const opinion = userMemoryService.getOpinionByUsername(username, guildId);

        if (!opinion) {
          await interaction.reply({
            // `username` is raw operator/moderator input echoed into `content`.
            // Someone running `/memories view @everyone` would otherwise ping
            // the server out of this command, whose entire output is private.
            content: `Zakira doesn't have any opinions about **${neutralizeMentions(username)}** yet.`,
            flags: MessageFlags.Ephemeral,
            allowedMentions: buildAllowedMentions(),
          });
          return;
        }

        const embed = new EmbedBuilder()
          .setTitle(`Zakira's Opinion About ${opinion.username}`)
          .setDescription(opinion.opinion)
          .addFields(
            { name: 'Sentiment', value: opinion.sentiment, inline: true },
            { name: 'Pronouns', value: opinion.pronouns || 'Not specified', inline: true },
            { name: 'First Met', value: new Date(opinion.createdAt).toLocaleDateString(), inline: true }
          )
          .setColor(
            opinion.sentiment === 'positive' ? 0x00FF00 :
            opinion.sentiment === 'negative' ? 0xFF0000 :
            opinion.sentiment === 'mixed' ? 0xFFA500 :
            0x808080
          )
          .setTimestamp();

        // Add third-party context if it exists
        if (opinion.thirdPartyContext) {
          embed.addFields({
            name: 'What Others Have Said',
            value: opinion.thirdPartyContext.length > 1024 
              ? opinion.thirdPartyContext.substring(0, 1021) + '...'
              : opinion.thirdPartyContext,
            inline: false,
          });
        }

        await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral, allowedMentions: buildAllowedMentions() });

      } else if (subcommand === 'clear') {
        // Deliberately cross-guild: this is the owner's "forget everything"
        // escape hatch, and deleteOpinion() with no guild id erases every scope.
        const users = userMemoryService.listMemorySummaries();
        let deletedCount = 0;

        for (const user of users) {
          deletedCount += userMemoryService.deleteOpinion(user.userId);
        }

        await interaction.reply({
          content: deletedCount > 0
            ? `✅ Cleared all user memories. ${deletedCount} opinion${deletedCount === 1 ? '' : 's'} removed.`
            : 'No stored opinions found to clear.',
          flags: MessageFlags.Ephemeral,
          allowedMentions: buildAllowedMentions(),
        });
      } else if (subcommand === 'clear-user') {
        const userId = interaction.options.getString('user-id', true);
        const opinion = userMemoryService.getOpinion(userId);
        const deletedCount = userMemoryService.deleteOpinion(userId);

        await interaction.reply({
          content: deletedCount > 0
            // The stored username is whatever Discord last reported, which a
            // user can change to anything; it lands in `content` here.
            ? `✅ Cleared stored opinion for ${neutralizeMentions(opinion?.username || userId)} (${userId}).`
            : `No stored opinion found for user ID ${userId}.`,
          flags: MessageFlags.Ephemeral,
          allowedMentions: buildAllowedMentions(),
        });
      }
    } catch (error) {
      console.error('Memories command error:', error);
      await interaction.reply({
        content: getErrorMessage('generic_error'),
        flags: MessageFlags.Ephemeral,
        allowedMentions: buildAllowedMentions(),
      });
    }
  },
};

export default command;
