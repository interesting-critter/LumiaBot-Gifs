import { 
  SlashCommandBuilder, 
  ChatInputCommandInteraction, 
  EmbedBuilder,
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  AttachmentBuilder,
} from 'discord.js';
import { spotifyService } from '../services/spotify';
import { navidromeService } from '../services/navidrome';
import { musicService, type MusicPlaylist } from '../services/music';
import { config } from '../utils/config';
import { buildAllowedMentions } from '../utils/permissions';
import { neutralizeMentions } from '../utils/mentions';
import type { Command } from '../bot/client';

// Re-exported so the tests (and any future command) can reach the mention
// defanger through this module without importing the util directly. The
// implementation lives in `src/utils/mentions.ts` because `/memories` needs it
// too, and a command importing another command's internals is worse than a
// command importing a util.
export { neutralizeMentions };

/** Discord rejects an embed description longer than this with a thrown error. */
const EMBED_DESCRIPTION_LIMIT = 4096;

/**
 * MENTION HARDENING — read this before adding a reply to this file.
 *
 * `/music` was missed by the mention-hardening pass that covered `/chat` and
 * `/search`, and it is the one command with an attacker-controlled string sitting
 * directly in `content`: a Spotify playlist title is chosen by whoever owns the
 * playlist, `/music list` is not owner-gated, and `/music delete` interpolated
 * that title into its confirmation prompt — so a playlist called `@everyone`
 * pinged the whole server:
 *
 *     ⚠️ Are you sure you want to delete "@everyone"?
 *
 * Two layers, because either alone is one edit away from being undone. Every
 * reply in this file sets `allowedMentions: buildAllowedMentions()` (Discord will
 * not parse mentions out of it), and every *dynamic* string placed in `content`
 * goes through `neutralizeMentions()` first (so there is no mention syntax left
 * to parse). `allowedMentions` is applied uniformly rather than only to the
 * audited `content` strings, because auditing each string by hand is exactly the
 * step that gets skipped on the next subcommand.
 */

/**
 * One parsed LRC line: when it is sung, and what is sung.
 */
export interface LrcLine {
  /** Start time in milliseconds, after the `[offset:]` tag has been applied. */
  timeMs: number;
  text: string;
}

/** `[m:ss]`, `[mm:ss.x]`, `[mm:ss.xx]`, `[mm:ss.xxx]`, plus the hour form
 *  `[h:mm:ss.xx]` and the colon-separated fraction some editors emit. */
const LRC_TIMESTAMP_RE =
  /^(?:\[(?<minutes>\d{1,3}):(?<seconds>[0-5]?\d)(?:[.:](?<fraction>\d{1,3}))?\]|\[(?<hours>\d{1,2}):(?<hourMinutes>[0-5]?\d):(?<hourSeconds>[0-5]?\d)(?:[.:](?<hourFraction>\d{1,3}))?\])/;

/** Metadata tags: `[ar:]`, `[ti:]`, `[al:]`, `[offset:]`, `[length:]`, … */
const LRC_METADATA_RE = /^\[[a-z_]+:[^\]]*\]\s*$/i;

/** Named capture groups of {@link LRC_TIMESTAMP_RE}. */
interface LrcTimestampGroups {
  minutes?: string;
  seconds?: string;
  fraction?: string;
  hours?: string;
  hourMinutes?: string;
  hourSeconds?: string;
  hourFraction?: string;
}

/**
 * Parse an LRC (or plain-text) lyric blob into time-ordered lines.
 *
 * WHY A REAL PARSER
 * -----------------
 * The previous display path did
 * `raw.replace(/\[\d{2}:\d{2}\.\d{2,3}\]/g, '')`, which:
 *   - missed `[01:02]` (no fraction) and `[1:02.3]` (single leading digit);
 *   - left metadata in the output (`[ar:Artist]`, `[offset:+250]`);
 *   - turned a repeated line `[00:01.00][00:05.00]Chorus` into `ChorusChorus`;
 *   - ignored `[offset:]` entirely, so synced lyrics drifted by the offset.
 *
 * WHAT THIS DOES
 * --------------
 * A line may carry any number of timestamp tags, each of which produces its own
 * entry (that is what a repeated chorus means in LRC). Metadata tags are
 * stripped, `[offset:]` is applied as `time - offset` (a positive offset means
 * the lyrics should appear *earlier*), and the result is sorted by time. Ties
 * keep source order because `Array.prototype.sort` is stable.
 *
 * Plain-text lyrics (no timestamps at all — the common case for Navidrome) are
 * returned verbatim as `timeMs: 0` entries so the embed still shows something;
 * in a file that does carry timestamps, untimestamped lines (`[Verse 1]`, stray
 * text) are metadata and are dropped. Whether the file is timed is decided in a
 * pre-pass, so a section header that appears *before* the first timestamp is
 * still recognised as metadata.
 */
export function parseLrcLyrics(raw: string | null | undefined): LrcLine[] {
  if (!raw) return [];

  const lines = raw.split(/\r?\n/);
  const entries: LrcLine[] = [];
  let offsetMs = 0;

  const isTimed = (candidate: string): boolean => LRC_TIMESTAMP_RE.test(candidate.trim());
  const timedFile = lines.some(isTimed);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    // Metadata tags are their own lines in practice, but `[offset:]` is honoured
    // wherever it appears so a file that puts it first still works.
    const metadata = LRC_METADATA_RE.exec(line);
    if (metadata) {
      const offsetMatch = /^\[offset:\s*([+-]?\d+)\s*\]$/i.exec(line);
      if (offsetMatch?.[1]) {
        const parsed = Number.parseInt(offsetMatch[1], 10);
        if (Number.isFinite(parsed)) offsetMs = parsed;
      }
      continue;
    }

    const times: number[] = [];
    let text = line;
    // Consume every leading timestamp tag on this line, then whatever remains
    // is the lyric text. Non-timestamp brackets mid-line are left alone (some
    // files use `[Chorus]` as a section label).
    for (;;) {
      const match = LRC_TIMESTAMP_RE.exec(text);
      if (!match) break;

      const groups = (match.groups ?? {}) as LrcTimestampGroups;
      const fractionMs = (digits: string | undefined): number =>
        digits === undefined ? 0 : Number.parseInt(digits.padEnd(3, '0'), 10);

      if (groups.seconds !== undefined) {
        times.push(
          Number.parseInt(groups.minutes ?? '0', 10) * 60_000 +
            Number.parseInt(groups.seconds, 10) * 1000 +
            fractionMs(groups.fraction),
        );
      } else {
        times.push(
          Number.parseInt(groups.hours ?? '0', 10) * 3_600_000 +
            Number.parseInt(groups.hourMinutes ?? '0', 10) * 60_000 +
            Number.parseInt(groups.hourSeconds ?? '0', 10) * 1000 +
            fractionMs(groups.hourFraction),
        );
      }

      text = text.slice(match[0].length).trim();
    }

    if (times.length === 0) {
      // Untimed file → plain lyrics, keep the line. Timed file → metadata, drop it.
      if (!timedFile) entries.push({ timeMs: 0, text: line });
      continue;
    }

    if (!text) continue; // instrumental gap, nothing to show
    for (const timeMs of times) {
      entries.push({ timeMs, text });
    }
  }

  if (offsetMs !== 0) {
    for (const entry of entries) {
      entry.timeMs -= offsetMs;
    }
  }

  return entries.sort((a, b) => a.timeMs - b.timeMs);
}

/**
 * Clamp a page index into `[0, pageCount - 1]`.
 *
 * `setDisabled` only takes effect after the awaited `update()` resolves, so two
 * rapid clicks on "next" both observe a stale `currentPage` and both increment.
 * Without a clamp the index walks past the end, `pages[currentPage]` is
 * `undefined`, and `update({ embeds: [undefined] })` throws inside a collector
 * listener that discord.js never awaits — an unhandled rejection.
 */
export function clampPageIndex(current: number, pageCount: number): number {
  if (pageCount <= 0) return 0;
  if (!Number.isFinite(current)) return 0;
  return Math.max(0, Math.min(pageCount - 1, Math.trunc(current)));
}

/**
 * Truncate an embed description to Discord's 4096-char limit.
 *
 * A raw `slice` can split a surrogate pair (mojibake) or leave a dangling
 * backslash that swallows the next character as a markdown escape; both are
 * avoided here, and an unterminated ``` code fence is closed.
 */
export function capEmbedDescription(text: string, limit: number = EMBED_DESCRIPTION_LIMIT): string {
  if (text.length <= limit) return text;

  const fenceCount = (text.match(/```/g) || []).length;
  const needsClosingFence = fenceCount % 2 === 1;
  const suffix = `${needsClosingFence ? '\n```' : ''}…`;
  const budget = Math.max(0, limit - suffix.length);

  let cut = text.slice(0, budget);
  // A high surrogate at the cut point means its low half was cut away.
  if (cut.length > 0) {
    const lastCode = cut.charCodeAt(cut.length - 1);
    if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
      cut = cut.slice(0, -1);
    }
  }
  // Never end on a lone escape character.
  cut = cut.replace(/\\+$/, '');

  return cut + suffix;
}

const musicCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('music')
    .setDescription('Manage Lumia\'s music knowledge and playlists')
    .setDefaultMemberPermissions(PermissionFlagsBits.SendMessages)
    .addSubcommand(subcommand =>
      subcommand
        .setName('import')
        .setDescription('Import a Spotify playlist into Lumia\'s music knowledge (owner only)')
        .addStringOption(option =>
          option
            .setName('url')
            .setDescription('Spotify playlist URL or ID')
            .setRequired(true)
        )
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('refresh')
        .setDescription('Refresh all saved Spotify playlists (owner only)')
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('list')
        .setDescription('List all imported playlists')
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('stats')
        .setDescription('Show music statistics and taste profile')
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('taste')
        .setDescription('Generate a music taste description based on imported tracks')
    )
    .addSubcommand(subcommand =>
         subcommand
           .setName('nowplaying')
           .setDescription('Show what is currently playing on Navidrome')
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('delete')
        .setDescription('Delete an imported playlist (owner only)')
        .addIntegerOption(option =>
          option
            .setName('id')
            .setDescription('Playlist ID to delete (use /music list to see IDs)')
            .setRequired(true)
        )
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('search')
        .setDescription('Search for tracks in the music database')
        .addStringOption(option =>
          option
            .setName('query')
            .setDescription('Search for track or artist name')
            .setRequired(true)
        )
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('clear-all')
        .setDescription('⚠️ Delete ALL music data (owner only)')
    ) as SlashCommandBuilder,
  ownerOnlySubcommands: ['import', 'refresh', 'delete', 'clear-all'],

  async execute(interaction: ChatInputCommandInteraction) {
  const subcommand = interaction.options.getSubcommand();

  try {
    switch (subcommand) {
      case 'import':
        await handleImport(interaction);
        break;
      case 'refresh':
        await handleRefresh(interaction);
        break;
      case 'list':
        await handleList(interaction);
        break;
      case 'stats':
        await handleStats(interaction);
        break;
      case 'taste':
        await handleTaste(interaction);
        break;
      case 'delete':
        await handleDelete(interaction);
        break;
      case 'search':
        await handleSearch(interaction);
        break;
      case 'clear-all':
        await handleClearAll(interaction);
        break;
      case 'nowplaying':
           await handleNowPlaying(interaction);
           break;
      default:
        await interaction.reply({
          allowedMentions: buildAllowedMentions(),
          content: '❓ Unknown subcommand!',
          ephemeral: true,
        });
    }
  } catch (error) {
    console.error('❌ [MUSIC COMMAND] Error:', error);
    const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
    
    if (interaction.replied || interaction.deferred) {
      await interaction.editReply({
        allowedMentions: buildAllowedMentions(),
        content: `❌ Error: ${neutralizeMentions(errorMessage)}`,
      });
    } else {
      await interaction.reply({
        allowedMentions: buildAllowedMentions(),
        content: `❌ Error: ${neutralizeMentions(errorMessage)}`,
        ephemeral: true,
      });
    }
  }
  },
};

export default musicCommand;

async function handleImport(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  // Check if Spotify is configured
  if (!spotifyService.isAvailable()) {
    await interaction.editReply({
      allowedMentions: buildAllowedMentions(),
      content: '❌ Spotify is not configured. Please set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET environment variables.',
    });
    return;
  }

  const url = interaction.options.getString('url', true);
  
  // Extract playlist ID
  const playlistId = spotifyService.extractPlaylistId(url);
  if (!playlistId) {
    await interaction.editReply({
      allowedMentions: buildAllowedMentions(),
      content: '❌ Invalid Spotify playlist URL or ID. Please provide a valid Spotify playlist link.',
    });
    return;
  }

  // Check if already imported
  const existingPlaylist = musicService.getPlaylistBySpotifyId(playlistId);
  const isReimport = !!existingPlaylist;

  await interaction.editReply({
    allowedMentions: buildAllowedMentions(),
    content: `🎵 Fetching playlist from Spotify... ${isReimport ? '(This will update the existing import)' : ''}`,
  });

  try {
    // Fetch playlist from Spotify
    const spotifyPlaylist = await spotifyService.getPlaylist(playlistId);

    await interaction.editReply({
      allowedMentions: buildAllowedMentions(),
      // Attacker-controlled: anyone who can share a playlist link chooses this
      // name, so it is untrusted text on the same footing as model output.
      content: `🎵 Found "${neutralizeMentions(spotifyPlaylist.name)}" with ${spotifyPlaylist.tracks.items.length} tracks. Importing...`,
    });

    // Import into database
    const result = await musicService.importPlaylist(
      spotifyPlaylist,
      spotifyPlaylist.tracks.items
    );

    // Create embed with results
    const embed = new EmbedBuilder()
      .setTitle(`🎵 Playlist ${isReimport ? 'Updated' : 'Imported'}!`)
      .setDescription(`**${spotifyPlaylist.name}**`)
      .setColor(isReimport ? 0xFFA500 : 0x1DB954) // Orange for update, Spotify green for new
      .setThumbnail(spotifyPlaylist.images[0]?.url || null)
      .addFields(
        { name: '📊 Tracks', value: `${result.importedTracks} total\n${result.newTracks} new · ${result.duplicateTracks} existing`, inline: true },
        { name: '🎤 Artists', value: `${result.newArtists} new\n${result.duplicateArtists} existing`, inline: true },
        { name: '💿 Albums', value: `${result.newAlbums} new\n${result.duplicateAlbums} existing`, inline: true },
        { name: '🎵 Total in DB', value: `${musicService.getStats().totalTracks} tracks`, inline: true },
        { name: '👤 Owner', value: spotifyPlaylist.owner.displayName, inline: true },
        { name: '🔗 Spotify', value: `[Open](https://open.spotify.com/playlist/${playlistId})`, inline: true }
      )
      .setFooter({ text: `Playlist ID: ${result.playlistId} • ${isReimport ? 'Updated' : 'Imported'} just now` });

    if (spotifyPlaylist.description) {
      embed.addFields({ name: '📝 Description', value: spotifyPlaylist.description.substring(0, 1024) });
    }

    await interaction.editReply({
      allowedMentions: buildAllowedMentions(),
      content: isReimport ? '✅ Playlist updated successfully!' : '✅ Playlist imported successfully!',
      embeds: [embed],
    });

  } catch (error) {
    console.error('❌ [MUSIC IMPORT] Error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Failed to import playlist';
    
    await interaction.editReply({
      allowedMentions: buildAllowedMentions(),
      // The Spotify exception text can quote the playlist name back at us.
      content: `❌ Failed to import playlist: ${neutralizeMentions(errorMessage)}`,
    });
  }
}

async function handleList(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const playlists = musicService.getAllPlaylists();

  if (playlists.length === 0) {
    await interaction.editReply({
      allowedMentions: buildAllowedMentions(),
      content: '🎵 No playlists imported yet! Use `/music import <spotify_url>` to add some music.',
    });
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle('🎵 Lumia\'s Music Collection')
    .setDescription(`${playlists.length} playlist(s) • ${musicService.getStats().totalTracks} total tracks`)
    .setColor(0x1DB954)
    .setFooter({ text: 'Use /music import to add more playlists' });

  const playlistFields = playlists.map((playlist: MusicPlaylist) => ({
    name: `${playlist.name} (ID: ${playlist.id})`,
    value: [
      `🎵 ${playlist.trackCount} tracks`,
      `👤 ${playlist.ownerName}`,
      `📅 Imported ${formatDate(playlist.importedAt)}`,
      playlist.imageUrl ? `[Cover](${playlist.imageUrl})` : '',
      `[Spotify](${playlist.spotifyUrl})`,
    ].filter(Boolean).join(' • '),
  }));

  // Discord has a limit of 25 fields per embed
  if (playlistFields.length <= 25) {
    embed.addFields(playlistFields);
    await interaction.editReply({ embeds: [embed], allowedMentions: buildAllowedMentions() });
  } else {
    // Paginate if more than 25 playlists
    const pages: EmbedBuilder[] = [];
    for (let i = 0; i < playlistFields.length; i += 25) {
      const pageEmbed = new EmbedBuilder()
        .setTitle(`🎵 Lumia\'s Music Collection (Page ${Math.floor(i / 25) + 1})`)
        .setDescription(`${playlists.length} playlist(s) • ${musicService.getStats().totalTracks} total tracks`)
        .setColor(0x1DB954)
        .addFields(playlistFields.slice(i, i + 25));
      pages.push(pageEmbed);
    }

    if (pages.length === 0) {
      await interaction.editReply({
        allowedMentions: buildAllowedMentions(),
        content: '🎵 No playlists to display.',
      });
      return;
    }

    let currentPage = 0;

    const row = new ActionRowBuilder<ButtonBuilder>()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('prev')
          .setLabel('◀ Previous')
          .setStyle(ButtonStyle.Primary)
          .setDisabled(true),
        new ButtonBuilder()
          .setCustomId('next')
          .setLabel('Next ▶')
          .setStyle(ButtonStyle.Primary)
          .setDisabled(pages.length === 1)
      );

    const currentEmbed = pages[currentPage] ?? pages[0];
    if (!currentEmbed) {
      await interaction.editReply({ content: '🎵 No playlists to display.', allowedMentions: buildAllowedMentions() });
      return;
    }

    const message = await interaction.editReply({
      allowedMentions: buildAllowedMentions(),
      embeds: [currentEmbed],
      components: [row],
    });

    const collector = message.createMessageComponentCollector({
      componentType: ComponentType.Button,
      time: 60000,
    });

    collector.on('collect', async (i) => {
      // A rejected `update()` here (deleted message, expired token) would escape
      // as an unhandled rejection: discord.js does not await collector listeners.
      try {
        if (i.user.id !== interaction.user.id) {
          await i.reply({ content: '❌ This button is not for you!', ephemeral: true, allowedMentions: buildAllowedMentions() });
          return;
        }

        if (i.customId === 'prev') {
          currentPage--;
        } else if (i.customId === 'next') {
          currentPage++;
        }

        // Two rapid clicks both read the pre-`await` value, so clamp instead of
        // trusting the disabled state to keep us in range.
        currentPage = clampPageIndex(currentPage, pages.length);

        const prevButton = row.components[0];
        const nextButton = row.components[1];
        prevButton?.setDisabled(currentPage === 0);
        nextButton?.setDisabled(currentPage === pages.length - 1);

        const updatedEmbed = pages[currentPage];
        if (!updatedEmbed) return;

        await i.update({
          allowedMentions: buildAllowedMentions(),
          embeds: [updatedEmbed],
          components: [row],
        });
      } catch (error) {
        console.error('❌ [MUSIC COMMAND] Pagination button failed:', error);
      }
    });

    collector.on('end', () => {
      row.components.forEach(btn => btn.setDisabled(true));
      interaction.editReply({ components: [row], allowedMentions: buildAllowedMentions() }).catch(() => {});
    });
  }
}

async function handleRefresh(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  if (!spotifyService.isAvailable()) {
    await interaction.editReply({
      allowedMentions: buildAllowedMentions(),
      content: '❌ Spotify is not configured. Please set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET environment variables.',
    });
    return;
  }

  const playlists = musicService.getAllPlaylists();

  if (playlists.length === 0) {
    await interaction.editReply({
      allowedMentions: buildAllowedMentions(),
      content: '🎵 No saved playlists to refresh yet. Use `/music import` first.',
    });
    return;
  }

  await interaction.editReply({
    allowedMentions: buildAllowedMentions(),
    content: `🎵 Refreshing ${playlists.length} saved playlist${playlists.length === 1 ? '' : 's'} from Spotify...`,
  });

  let refreshedCount = 0;
  let totalTracks = 0;
  let newTracks = 0;
  const failures: string[] = [];

  for (const playlist of playlists) {
    try {
      const spotifyPlaylist = await spotifyService.getPlaylist(playlist.spotifyId);
      const result = await musicService.importPlaylist(
        spotifyPlaylist,
        spotifyPlaylist.tracks.items
      );

      refreshedCount++;
      totalTracks += result.importedTracks;
      newTracks += result.newTracks;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      // Playlist name and Spotify error text are both attacker-influenced. This
      // lands in an embed field, which never pings, but neutralising keeps the
      // same string safe if it is ever promoted into `content`.
      failures.push(`${neutralizeMentions(playlist.name)}: ${neutralizeMentions(message)}`);
      console.error(`❌ [MUSIC REFRESH] Failed to refresh playlist ${playlist.spotifyId}:`, error);
    }
  }

  const embed = new EmbedBuilder()
    .setTitle('🎵 Playlist Refresh Complete')
    .setColor(failures.length > 0 ? 0xFFA500 : 0x1DB954)
    .addFields(
      { name: 'Refreshed', value: `${refreshedCount}/${playlists.length} playlists`, inline: true },
      { name: 'Tracks Linked', value: `${totalTracks}`, inline: true },
      { name: 'New Tracks', value: `${newTracks}`, inline: true }
    )
    .setTimestamp();

  if (failures.length > 0) {
    const failureText = failures
      .slice(0, 5)
      .map(failure => `• ${failure}`)
      .join('\n');
    embed.addFields({
      name: `Failures (${failures.length})`,
      value: failures.length > 5 ? `${failureText}\n...and ${failures.length - 5} more` : failureText,
      inline: false,
    });
  }

  await interaction.editReply({
    allowedMentions: buildAllowedMentions(),
    content: refreshedCount > 0 ? '✅ Saved playlists refreshed.' : '❌ No playlists could be refreshed.',
    embeds: [embed],
  });
}

async function handleStats(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const stats = musicService.getStats();

  if (stats.totalTracks === 0) {
    await interaction.editReply({
      allowedMentions: buildAllowedMentions(),
      content: '🎵 No music in the database yet! Use `/music import <spotify_url>` to add some.',
    });
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle('🎵 Lumia\'s Music Stats')
    .setDescription('Current state of my musical knowledge')
    .setColor(0x1DB954)
    .addFields(
      { name: '📁 Playlists', value: `${stats.totalPlaylists}`, inline: true },
      { name: '🎵 Tracks', value: `${stats.totalTracks}`, inline: true },
      { name: '🎤 Artists', value: `${stats.totalArtists}`, inline: true },
      { name: '💿 Albums', value: `${stats.totalAlbums}`, inline: true }
    );

  // Top genres
  if (stats.topGenres.length > 0) {
    const genreText = stats.topGenres
      .slice(0, 10)
      .map((g, i) => `${i + 1}. ${g.genre} (${g.count} artists)`)
      .join('\n');
    
    embed.addFields({
      name: '🎸 Top Genres',
      value: genreText || 'No genre data available',
    });
  }

  // Top artists
  if (stats.topArtists.length > 0) {
    const artistText = stats.topArtists
      .slice(0, 10)
      .map((a, i) => `${i + 1}. ${a.artist.name} (${a.trackCount} tracks)`)
      .join('\n');
    
    embed.addFields({
      name: '⭐ Top Artists (by track count)',
      value: artistText || 'No artist data available',
    });
  }

  // All genres list
  const allGenres = musicService.getAllGenres();
  if (allGenres.length > 0) {
    const genreSummary = allGenres.slice(0, 20).join(', ');
    const moreText = allGenres.length > 20 ? ` (+${allGenres.length - 20} more)` : '';
    embed.addFields({
      name: `🎼 All Genres (${allGenres.length} total)`,
      value: genreSummary + moreText,
    });
  }

  await interaction.editReply({ embeds: [embed], allowedMentions: buildAllowedMentions() });
}

async function handleTaste(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: false });

  const stats = musicService.getStats();

  if (stats.totalTracks === 0) {
    await interaction.editReply({
      allowedMentions: buildAllowedMentions(),
      content: '🎵 I don\'t have any music imported yet! Ask someone to `/music import` some Spotify playlists so I can develop my taste!',
    });
    return;
  }

  // Get random sample of tracks for taste generation
  const sampleTracks = musicService.getRandomTracks(20);
  
  // Get genre breakdown
  const genreCounts = new Map<string, number>();
  sampleTracks.forEach(track => {
    track.genres.forEach(genre => {
      genreCounts.set(genre, (genreCounts.get(genre) || 0) + 1);
    });
  });

  const topGenres = Array.from(genreCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  // Get unique artists
  const artists = [...new Set(sampleTracks.flatMap(t => t.artists.map(a => a.name)))];
  
  // Calculate average popularity
  const avgPopularity = Math.round(
    sampleTracks.reduce((sum, t) => sum + t.popularity, 0) / sampleTracks.length
  );

  // Create taste description
  let tasteDescription = '';
  
  if (topGenres.length > 0) {
    tasteDescription += `I'm really into **${topGenres.map(g => g[0]).join(', ')}** right now. `;
  }

  tasteDescription += `My collection has **${stats.totalTracks} tracks** across **${stats.totalPlaylists} playlists**. `;

  if (artists.length > 0) {
    const artistSample = artists.slice(0, 5).join(', ');
    tasteDescription += `I've been listening to artists like **${artistSample}**${artists.length > 5 ? ` and ${artists.length - 5} more` : ''}. `;
  }

  if (avgPopularity < 30) {
    tasteDescription += "I'm into pretty obscure stuff that most people haven't heard of.";
  } else if (avgPopularity < 60) {
    tasteDescription += "I like a mix of mainstream hits and hidden gems.";
  } else {
    tasteDescription += "I'm not afraid to admit I love popular music!";
  }

  const embed = new EmbedBuilder()
    .setTitle('🎵 My Music Taste')
    .setDescription(tasteDescription)
    .setColor(0x1DB954)
    .addFields(
      { 
        name: '🎭 Taste Profile', 
        value: [
          `Popularity: ${avgPopularity}/100`,
          `Main Genres: ${topGenres.length > 0 ? topGenres.map(g => g[0]).join(', ') : 'Mixed'}`,
          `Artist Diversity: ${stats.totalArtists} unique artists`,
        ].join('\n'),
      },
      {
        name: '🎲 Random Sample from My Collection',
        value: sampleTracks
          .slice(0, 5)
          .map(t => `• **${t.name}** - ${t.artists.map(a => a.name).join(', ')}`)
          .join('\n') || 'No tracks available',
      }
    )
    .setFooter({ text: 'These are tracks I actually know and can talk about!' });

  await interaction.editReply({ embeds: [embed], allowedMentions: buildAllowedMentions() });
}

async function handleDelete(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const playlistId = interaction.options.getInteger('id', true);
  
  // Get playlist info before deleting
  const playlists = musicService.getAllPlaylists();
  const playlist = playlists.find(p => p.id === playlistId);

  if (!playlist) {
    await interaction.editReply({
      allowedMentions: buildAllowedMentions(),
      content: `❌ Playlist with ID ${playlistId} not found. Use \`/music list\` to see available playlists.`,
    });
    return;
  }

  // Create confirmation buttons
  const row = new ActionRowBuilder<ButtonBuilder>()
    .addComponents(
      new ButtonBuilder()
        .setCustomId('confirm')
        .setLabel('✅ Yes, Delete')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId('cancel')
        .setLabel('❌ Cancel')
        .setStyle(ButtonStyle.Secondary)
    );

  const confirmMessage = await interaction.editReply({
    allowedMentions: buildAllowedMentions(),
    // THE live ping. `playlist.name` is whatever the playlist's Spotify owner
    // typed, and `/music list` is not owner-gated, so any member could import
    // (or an owner could be tricked into importing) a playlist called
    // `@everyone` and then trigger this prompt — which used to reach Discord as
    // `⚠️ Are you sure you want to delete "@everyone"?` and ping the whole server.
    // Both layers are needed: `allowedMentions` above stops Discord parsing the
    // mention, `neutralizeMentions` stops the text being a mention at all.
    content: `⚠️ Are you sure you want to delete "${neutralizeMentions(playlist.name)}"? Tracks only in this playlist are removed too; tracks shared with another playlist are kept.`,
    components: [row],
  });

  const collector = confirmMessage.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: 30000,
  });

  collector.on('collect', async (i) => {
    try {
      if (i.user.id !== interaction.user.id) {
        await i.reply({ content: '❌ This button is not for you!', ephemeral: true, allowedMentions: buildAllowedMentions() });
        return;
      }

      if (i.customId === 'confirm') {
        await musicService.deletePlaylist(playlistId);
        await i.update({
          allowedMentions: buildAllowedMentions(),
          content: `✅ Deleted "${neutralizeMentions(playlist.name)}" from the playlist collection.`,
          components: [],
        });
      } else {
        await i.update({
          allowedMentions: buildAllowedMentions(),
          content: '❌ Deletion cancelled.',
          components: [],
        });
      }

      collector.stop();
    } catch (error) {
      console.error('❌ [MUSIC COMMAND] Delete confirmation failed:', error);
    }
  });

  collector.on('end', (collected) => {
    if (collected.size === 0) {
      interaction.editReply({
        allowedMentions: buildAllowedMentions(),
        content: '⏱️ Confirmation timed out. Playlist not deleted.',
        components: [],
      }).catch(() => {});
    }
  });
}

async function handleSearch(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const query = interaction.options.getString('query', true);
  const tracks = musicService.searchTracks(query, 10);
  // `query` is typed by whoever runs the subcommand, and it is echoed straight
  // back into `content`, so `/music search @everyone` is its own ping.
  const safeQuery = neutralizeMentions(query);

  if (tracks.length === 0) {
    await interaction.editReply({
      allowedMentions: buildAllowedMentions(),
      content: `🔍 No tracks found matching "${safeQuery}". Try a different search term!`,
    });
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle(`🔍 Search Results: "${safeQuery}"`)
    .setDescription(`Found ${tracks.length} track(s)`)
    .setColor(0x1DB954);

  const trackFields = tracks.map((track, i) => ({
    name: `${i + 1}. ${track.name}`,
    value: [
      `🎤 ${track.artists.map(a => a.name).join(', ')}`,
      `💿 ${track.album.name}`,
      track.genres.length > 0 ? `🎸 ${track.genres.slice(0, 3).join(', ')}` : '',
      `[Spotify](${track.spotifyUrl})`,
    ].filter(Boolean).join(' • '),
  }));

  embed.addFields(trackFields);

  await interaction.editReply({ embeds: [embed], allowedMentions: buildAllowedMentions() });
}

async function handleClearAll(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const stats = musicService.getStats();

  if (stats.totalPlaylists === 0 && stats.totalTracks === 0) {
    await interaction.editReply({
      allowedMentions: buildAllowedMentions(),
      content: '📭 Music database is already empty!',
    });
    return;
  }

  // Create confirmation buttons
  const row = new ActionRowBuilder<ButtonBuilder>()
    .addComponents(
      new ButtonBuilder()
        .setCustomId('confirm-clear')
        .setLabel('⚠️ Yes, Delete Everything')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId('cancel-clear')
        .setLabel('❌ Cancel')
        .setStyle(ButtonStyle.Secondary)
    );

  const confirmMessage = await interaction.editReply({
    allowedMentions: buildAllowedMentions(),
    content: `⚠️ **WARNING: This will DELETE ALL MUSIC DATA!**\n\nThis action cannot be undone.\n\n📊 Current data:\n• ${stats.totalPlaylists} playlists\n• ${stats.totalTracks} tracks\n• ${stats.totalArtists} artists\n• ${stats.totalAlbums} albums\n\nAre you absolutely sure?`,
    components: [row],
  });

  const collector = confirmMessage.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: 30000,
  });

  collector.on('collect', async (i) => {
    try {
      if (i.user.id !== interaction.user.id) {
        await i.reply({ content: '❌ This button is not for you!', ephemeral: true, allowedMentions: buildAllowedMentions() });
        return;
      }

      if (i.customId === 'confirm-clear') {
        const deleted = musicService.clearAll();
        await i.update({
          allowedMentions: buildAllowedMentions(),
          content: `✅ **All music data deleted!**\n\n🗑️ Deleted:\n• ${deleted.playlistsDeleted} playlists\n• ${deleted.tracksDeleted} tracks\n• ${deleted.artistsDeleted} artists\n• ${deleted.albumsDeleted} albums`,
          components: [],
        });
      } else {
        await i.update({
          allowedMentions: buildAllowedMentions(),
          content: '❌ Clear operation cancelled.',
          components: [],
        });
      }

      collector.stop();
    } catch (error) {
      console.error('❌ [MUSIC COMMAND] Clear-all confirmation failed:', error);
    }
  });

  collector.on('end', (collected) => {
    if (collected.size === 0) {
      interaction.editReply({
        allowedMentions: buildAllowedMentions(),
        content: '⏱️ Confirmation timed out. No data was deleted.',
        components: [],
      }).catch(() => {});
    }
  });
}

function formatDate(isoString: string): string {
  const date = new Date(isoString);
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/**
 * Handles fetching and paginating lyrics in an interactive embed
 */
async function handleNowPlaying(interaction: ChatInputCommandInteraction) {
  // Ephemeral, and the listener identity below is owner-only. This subcommand is
  // not owner-gated, so a public reply leaked the operator's private Navidrome
  // account name into every guild the bot is in — and broadcast full lyric text.
  await interaction.deferReply({ ephemeral: true });
  const isOwner = config.bot.ownerId !== '' && interaction.user.id === config.bot.ownerId;

  if (!navidromeService.isAvailable()) {
    await interaction.editReply({
      allowedMentions: buildAllowedMentions(),
      content: '❌ Navidrome is not configured. Please set NAVIDROME_URL, NAVIDROME_USER, and NAVIDROME_PASSWORD in your environment.',
    });
    return;
  }

  try {
    const nowPlaying = await navidromeService.getNowPlaying();

    if (nowPlaying.length === 0) {
      await interaction.editReply({
        allowedMentions: buildAllowedMentions(),
        content: '🎧 Nothing is currently playing on Navidrome.',
      });
      return;
    }

    const current = nowPlaying[0];

    // The length check above already guarantees this is defined; the guard only
    // satisfies noUncheckedIndexedAccess and keeps a malformed response from
    // throwing on a deferred interaction.
    if (!current) {
      await interaction.editReply({
        allowedMentions: buildAllowedMentions(),
        content: '🎧 Nothing is currently playing on Navidrome.',
      });
      return;
    }

    // Fetch lyrics directly for the track.
    // NOTE: Navidrome's own lyrics are used verbatim. Do not try to "fix" a
    // wrong-song match here — that belongs to the LRCLIB lookup, which verifies
    // artist/title before returning (see src/services/lrclib.ts).
    const rawLyrics = await navidromeService.getLyrics(current.artist, current.title);
    const lyricsLines: string[] = parseLrcLyrics(rawLyrics).map((line) => line.text);

    // Viewport window settings
    const VIEWPORT_SIZE = 5; // Number of lines visible at once
    let currentLineIndex = 0; // The active/highlighted line index

    // Helper to render the embed
    const renderEmbed = (activeIndex: number) => {
      const embed = new EmbedBuilder()
        .setTitle('🎧 Currently Playing on Navidrome')
        .setColor(0x00a4dc);

      // Long track/artist names plus a lyrics viewport are concatenated with no
      // bound; Discord throws above 4096 chars, and that throw happened inside
      // the button collector. Cap it here instead.
      let desc = `**${current.title}**\nby **${current.artist}**\n`;

      if (lyricsLines.length > 0) {
        desc += '\n**Lyrics:**\n```\n';

        const half = Math.floor(VIEWPORT_SIZE / 2);
        let start = activeIndex - half;
        let end = activeIndex + half + 1;

        if (start < 0) {
          end = Math.min(lyricsLines.length, end + Math.abs(start));
          start = 0;
        }
        if (end > lyricsLines.length) {
          start = Math.max(0, start - (end - lyricsLines.length));
          end = lyricsLines.length;
        }

        for (let i = start; i < end; i++) {
          if (i === activeIndex) {
            desc += `> ${lyricsLines[i]}\n`; // Highlighted line
          } else {
            desc += `  ${lyricsLines[i]}\n`;
          }
        }
        desc += '```';
      } else {
        desc += '\n*(No lyrics available for this track)*\n';
      }

      embed.setDescription(capEmbedDescription(desc));

      embed.addFields(
        // Discord's field-value cap is 1024, and album titles come from tags.
        { name: '💿 Album', value: capEmbedDescription(current.album, 1024), inline: true },
        {
          name: '⏱️ Status',
          value: current.minutesAgo === 0 ? 'Playing now' : `Played ${current.minutesAgo}m ago`,
          inline: true,
        }
      );

      // The Navidrome account name is the operator's private identity, not the
      // listener's, and this subcommand is not owner-gated.
      if (isOwner) {
        embed.addFields({ name: '👤 Listener', value: current.username, inline: true });
      }

      if (current.coverArt) {
        embed.setThumbnail('attachment://cover.jpg');
      }

      if (lyricsLines.length > 0) {
        embed.setFooter({
          text: `Line ${activeIndex + 1} of ${lyricsLines.length} • Use buttons below to scroll`,
        });
      }

      return embed;
    };

    // Helper to render buttons (5 lines up / down side by side)
    const renderRow = (activeIndex: number) => {
      return new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId('lyrics_prev_fast')
          .setLabel('▲ Up')
          .setStyle(ButtonStyle.Primary)
          .setDisabled(activeIndex === 0),
        new ButtonBuilder()
          .setCustomId('lyrics_next_fast')
          .setLabel('▼ Down')
          .setStyle(ButtonStyle.Primary)
          .setDisabled(activeIndex >= lyricsLines.length - 1)
      );
    };

    const files: AttachmentBuilder[] = [];
    if (current.coverArt) {
      const artBuffer = await navidromeService.getCoverArtBuffer(current.coverArt);
      if (artBuffer) {
        files.push(new AttachmentBuilder(artBuffer, { name: 'cover.jpg' }));
      }
    }

    const initialComponents = lyricsLines.length > 0 ? [renderRow(currentLineIndex)] : [];

    const replyMsg = await interaction.editReply({
      allowedMentions: buildAllowedMentions(),
      embeds: [renderEmbed(currentLineIndex)],
      files,
      components: initialComponents,
    });

    if (lyricsLines.length === 0) return;

    // Allow scrolling for 5 minutes
    const collector = replyMsg.createMessageComponentCollector({
      componentType: ComponentType.Button,
      time: 300_000,
    });

    collector.on('collect', async (btnInteraction) => {
      // Same two gaps as the list collector: discord.js does not await collector
      // listeners, so a rejected `update()` (deleted message, stale token) is an
      // unhandled rejection; and this collector was the only one in the file
      // missing the "is this your button?" check.
      try {
        if (btnInteraction.user.id !== interaction.user.id) {
          await btnInteraction.reply({ content: '❌ This button is not for you!', ephemeral: true, allowedMentions: buildAllowedMentions() });
          return;
        }

        if (btnInteraction.customId === 'lyrics_prev_fast') {
          currentLineIndex = Math.max(0, currentLineIndex - 5);
        } else if (btnInteraction.customId === 'lyrics_next_fast') {
          currentLineIndex = Math.min(lyricsLines.length - 1, currentLineIndex + 5);
        }

        await btnInteraction.update({
          allowedMentions: buildAllowedMentions(),
          embeds: [renderEmbed(currentLineIndex)],
          components: [renderRow(currentLineIndex)],
        });
      } catch (error) {
        console.error('❌ [NAVIDROME] Lyrics button failed:', error);
      }
    });

    collector.on('end', () => {
      // Disable buttons after collector expires
      const disabledRow = renderRow(currentLineIndex);
      disabledRow.components.forEach((btn) => btn.setDisabled(true));
      interaction.editReply({ components: [disabledRow], allowedMentions: buildAllowedMentions() }).catch(() => {});
    });
  } catch (error) {
    console.error('❌ [NAVIDROME] Error:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    await interaction.editReply({
      allowedMentions: buildAllowedMentions(),
      content: `❌ Failed to fetch from Navidrome: ${neutralizeMentions(message)}`,
    });
  }
}
