# LumiaBot

A Discord bot built with Bun + TypeScript that provides AI-powered chat completions with optional web search capabilities via SearXNG.

## Features

- **AI Chat Completions**: Powered by OpenAI's GPT models
- **Web Search Integration**: Uses SearXNG for real-time web search results
- **Message Triggers**: Responds to mentions (@bot) and keywords ("Bad Kitty", "Lumia")
- **Slash Commands**: Modern Discord slash command interface
- **Streaming Support**: Real-time response streaming (optional)
- **TypeScript**: Fully typed for better development experience
- **Bun Runtime**: Fast, modern JavaScript runtime

## Prerequisites

- [Bun](https://bun.sh) installed (v1.3.5 or higher)
- A Discord Application with Bot token
- OpenAI API key
- SearXNG instance (public or self-hosted)

## Installation

1. **Clone the repository** (or create from scratch):
```bash
cd LumiaBot
```

2. **Install dependencies**:
```bash
bun install
```

3. **Configure environment variables**:
```bash
cp .env.example .env
# Edit .env with your actual credentials
```

4. **Set up bot definitions** (IMPORTANT):
```bash
# Create the prompt_storage directory structure
mkdir -p prompt_storage/persona prompt_storage/instructions prompt_storage/config

# Copy example templates from prompt_storage.example/
cp -r prompt_storage.example/* prompt_storage/

# Edit the files to create your own bot personality
# See BOT_SETUP.md for detailed instructions
```

## Configuration

Create a `.env` file with the following variables:

```env
# Discord Bot Configuration
DISCORD_TOKEN=your_discord_bot_token_here
DISCORD_CLIENT_ID=your_discord_application_id_here
DISCORD_CLIENT_SECRET=your_discord_client_secret_here
DISCORD_REDIRECT_URI=http://localhost:3000/auth/callback

# Bot Identity Configuration (Optional)
# These values are used as template variables in prompt_storage files
# BOT_NAME=Bad Kitty                    # Bot's display name
# BOT_OWNER_NAME=Prolix                 # Owner's name
# OWNER_ID=your_discord_user_id_here    # Owner's Discord ID (no default owner; see below)
# BOT_OWNER_USERNAME=prolix_oc          # Owner's Discord username

# OpenAI Configuration
OPENAI_API_KEY=your_openai_api_key_here
# OPENAI_BASE_URL=https://api.openai.com/v1  # Optional: Custom API base URL (e.g., for OpenRouter, Together AI)
OPENAI_MODEL=gpt-4o-mini
# OPENAI_MODEL_ALIAS=gpt-4o-mini  # Optional: Map to a different model name for the provider
OPENAI_MAX_TOKENS=2000
OPENAI_TEMPERATURE=0.7
OPENAI_FILTER_REASONING=true  # Filter out reasoning content from responses (e.g., o1/o3 models)

# SearXNG Configuration
SEARXNG_URL=https://search.example.com
SEARXNG_MAX_RESULTS=5
SEARXNG_SAFE_SEARCH=1

# Server Configuration
PORT=3000
```

### Bot Identity Configuration

You can customize your bot's identity and owner information through environment variables. These values are used as template variables (e.g., `{botName}`, `{ownerName}`) in your prompt_storage files:

```env
# Optional - Bot identity (defaults shown)
BOT_NAME=Bad Kitty                    # Bot's display name
BOT_OWNER_NAME=Prolix                 # Owner's name
OWNER_ID=your_discord_user_id_here    # Owner's Discord ID (no default owner; see below)
BOT_OWNER_USERNAME=prolix_oc          # Owner's Discord username
```

These variables allow you to:
- Change the bot's name without editing prompt files
- Set the bot's owner for special recognition in prompts
- Maintain consistent identity across all prompt templates

See `BOT_SETUP.md` for more details on using template variables in your bot's personality files.

#### `OWNER_ID` gates privileges, not just prompts

The rest of these variables only feed template variables into
`prompt_storage/`. `OWNER_ID` is different: it is the live authorisation check
behind every owner-only feature — memory wipes, global config changes, and
`/ratelimit` / `/boredom` when no trusted roles are configured. It also exempts
the owner from the chat rate limit.

```env
OWNER_ID=your_discord_user_id_here    # Your Discord user id
```

The bot reads `OWNER_ID` first and falls back to `BOT_OWNER_ID` only when
`OWNER_ID` is unset or blank, so a stale `BOT_OWNER_ID` left in an old `.env`
cannot override the `OWNER_ID` you just added. Use `OWNER_ID` for new setups;
`BOT_OWNER_ID` remains a working alias so existing deployments keep their owner
across the upgrade.

> **There is no default owner.** If neither variable is set — or either is left
> blank — the bot resolves an empty owner id and **every** owner-only command
> denies, for you as well as for everyone else. That fail-closed default is
> deliberate: a shipped default owner id would silently grant full privileges,
> including the ability to erase every user's stored memories, to whoever holds
> that account. The cost is that the denial raises no error at the call site, so
> it reads like a permissions problem rather than a missing variable. Set
> `OWNER_ID` if owner-only commands appear to be denied for everyone.

### Using Custom AI Providers

The bot supports custom OpenAI-compatible API providers such as:
- **OpenRouter** (access to multiple models)
- **Together AI**
- **Groq**
- **Google GenAI** (supports video/audio modality)
- **Local models** (via llama.cpp, etc.)

**Example: OpenRouter Configuration**
```env
OPENAI_BASE_URL=https://openrouter.ai/api/v1
OPENAI_API_KEY=your_openrouter_key_here
OPENAI_MODEL=anthropic/claude-sonnet-4-5
OPENAI_MODEL_ALIAS=claude-sonnet-4-5  # Optional: alias for the model
```

**Example: Local Model via llama.cpp**
```env
OPENAI_BASE_URL=http://localhost:8080/v1
OPENAI_API_KEY=optional-for-local
OPENAI_MODEL=local-model
```

### Using Google GenAI (Direct Gemini API)

For Gemini 3 models, you can use Google's native GenAI SDK instead of going through an OpenAI-compatible proxy. This provides better native support for Gemini-specific features.

**When to use this:**
- When using Gemini 3 Flash/Pro models
- When you have direct access to Google's Gemini API
- When you want to avoid proxy layers

**Configuration:**
```env
# Set the model to a Gemini 3 variant
OPENAI_MODEL=gemini-3-flash

# Configure Google GenAI (required to activate the native SDK)
GEMINI_API_KEY=your_gemini_api_key_here  # Get from https://ai.google.dev/
# GEMINI_BASE_URL=https://generativelanguage.googleapis.com  # Optional: for custom endpoints
```

**How it works:**
- If `GEMINI_API_KEY` is set AND the model name contains "gemini-3", the bot automatically uses the Google GenAI SDK
- Otherwise, it falls back to the OpenAI SDK (for OpenRouter, Together AI, etc.)
- The bot logs which service it's using on startup: `[AI Service] Using Google GenAI for gemini-3-flash`

### Getting Discord Credentials

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Create a new application
3. Go to "Bot" section and create a bot
4. Copy the bot token (DISCORD_TOKEN)
5. Go to "OAuth2" → "General" and copy the Client ID (DISCORD_CLIENT_ID) and Client Secret (DISCORD_CLIENT_SECRET)
6. In "OAuth2" → "URL Generator", select `bot` and `applications.commands` scopes, then copy the generated URL to invite your bot

### Getting OpenAI API Key

1. Go to [OpenAI Platform](https://platform.openai.com/)
2. Create an account or sign in
3. Go to API keys section and create a new secret key

### Setting up SearXNG

You have two options:

**Option 1: Use a public instance**
- Find public instances at [searx.space](https://searx.space/)
- Note: Public instances may have rate limits

**Option 2: Self-host SearXNG**
```bash
docker run -d --name searxng -p 8080:8080 -e "BASE_URL=http://localhost:8080" searxng/searxng
```

## Usage

### Register Slash Commands

Before using the bot, register the slash commands with Discord:

```bash
bun run register-commands
```

### Start the Bot

Development mode (with hot reload):
```bash
bun run dev
```

Production mode:
```bash
bun run start
```

### Available Commands

Once the bot is running and invited to your server, use these slash commands:

- **`/chat <message> [search]`** - Chat with the AI
  - `message`: Your question or message
  - `search`: (Optional) Enable web search for better answers

- **`/search <query> [category] [timerange]`** - Search the web
  - `query`: What to search for
  - `category`: (Optional) Filter by category (general, images, news, science, files)
  - `timerange`: (Optional) Filter by time (day, month, year)

- **`/ratelimit status|set <seconds>`** - View or change the chat rate limit (owner or trusted role)

## Rate Limiting

The bot allows **one request per `RATE_LIMIT_SECONDS` window, per user**. When a
user triggers the bot again inside that window, the request is dropped and the
bot simply reacts to the message with `RATE_LIMIT_EMOJI` instead of replying.

**Exemptions**

- The bot owner (`OWNER_ID` / `BOT_OWNER_ID`) is always exempt.
- Anyone holding a role listed in `RATE_LIMIT_EXEMPT_ROLES` is exempt. Entries
  may be role **IDs or exact role names** (names are matched case-insensitively):

```env
RATE_LIMIT_SECONDS=60
RATE_LIMIT_EXEMPT_ROLES=123456789012345678,Moderator
RATE_LIMIT_EMOJI=rate_limited
```

`RATE_LIMIT_EMOJI` accepts a Developer Dashboard **application emoji name**
(resolved from the app's emoji cache), a server emoji, or a plain unicode emoji.
No API call is made for the reaction itself.

**Changing the window at runtime**

```bash
/ratelimit status        # current window, exempt roles
/ratelimit set 15        # 15-second window
```

`/ratelimit set` persists to `dashboard_settings.db`, so the value survives a
restart. To go back to the environment default, change `RATE_LIMIT_SECONDS` and
restart. The minimum window is 1 second, which still allows one request per
second — it does not disable limiting entirely.

**Access to privileged commands**

`/ratelimit` and `/boredom` are restricted to the **bot owner** and members of a
role listed in `RATE_LIMIT_EXEMPT_ROLES`. That list is deliberately shared: it is
the single set of "trusted" roles, used both to bypass rate limiting and to
authorise these commands.

> **Note:** this is a change from earlier versions, where a guild's owner and
> anyone with Administrator or Ban Members could also run these commands. Those
> permissions were removed because `/boredom interval`, `/boredom trigger` and
> `/ratelimit set` all write **global** bot state — a server admin could otherwise
> reconfigure the bot for every other server it is in. Guild-scoped permissions
> cannot authorise global writes.
>
> If `RATE_LIMIT_EXEMPT_ROLES` is empty, both commands are owner-only.

## Dashboard

A mobile-friendly web dashboard for monitoring the bot and managing memories. It
starts automatically with the bot.

```bash
# then open http://localhost:3001 in your phone's browser
```

By default it binds to `127.0.0.1`, so it is only reachable from the device
running the bot and needs no password. It is intentionally on a **separate port**
from `PORT` so it never collides with the orchestrator websocket.

**Tabs**

A bottom bar carries the four you reach for daily, with everything else behind
**More**. The same four appear as a left rail from 64rem.

- **Overview** — Activation count for the rolling window, an hour-by-hour
  activity chart, the most recent turn, people / reply time / failures, the
  active model (switchable, see below), the request budget, per-model request
  counts, and bot, guild, orchestrator and rate-limit details.
- **Log** — Every activation within the rolling window (default 12h) with the
  exact prompt, the response, the trigger type (mention / keyword / reply /
  orchestrator / boredom), timestamps, and how long the turn took. Searchable
  and filterable, with collapsible entries. The collapsed view shows only the
  user's own message; opening an entry adds a **Full prompt sent to the model**
  disclosure with the complete payload as it was transmitted — the assembled
  system prompt (identity, guidelines, memory, knowledge, attached files) plus
  every turn, including the datetime reminder prefix. A **Latency and busiest
  hours** panel adds p50/p95/p99 reply time, an hour-of-day heatmap, and people
  and channel leaderboards.

  The payload is captured by the AI service at the moment it hands the request
  to the provider, so it reflects the real thing rather than a reconstruction.
  Turns that fail before the model is reached have no payload, and the
  disclosure is omitted. Because the system prompt is nearly identical turn to
  turn, distinct payloads are stored once and shared, so a long persona is not
  duplicated per entry.
- **Memory** — Browse every user the bot has a memory of. Expand a user to view
  individual memories and edit, delete, or add them. Profile fields (username,
  pronouns, sentiment) are editable too.
- **Knowledge** — The knowledge base the bot retrieves from. Search by keyword,
  filter by topic, and open a document to edit its title, topic, type,
  priority, URL, keywords and content, or delete it. **Reload from files**
  re-imports `./knowledge_documents` on demand, matching by title and topic.

**More**

- **Conversations** — Stored message history per person and per server, newest
  first. Read a transcript, clear one conversation, or clear everything for a
  person across every server.
- **Integrations** — Liveness for the local SearXNG and Navidrome servers:
  online, unreachable, or not configured, with address, response time, status
  code and detail. Probes are timeout-bounded, so one dead server cannot stall
  the page.
- **Persona** — Edit every file under `prompt_storage/` that the bot actually
  reads (identity, reinforcement, guideline, instruction, trigger and tool
  description files). **Save and reload** writes the file and drops the in-memory
  persona and prompt caches, so the change applies to the bot's very next
  message with no restart. JSON files are validated before they reach disk, and
  unsaved edits are guarded when you switch files or tabs. Files present on disk
  that no getter reads are listed read-only.
- **Setup** — Auto-refresh toggle and interval, a manual "add memory" form, a
  configuration summary, and the API counter reset.

### Switching models live

List the models you want to be able to switch between:

```env
DASHBOARD_MODEL_OPTIONS=gpt-4o,kimi-k2-thinking,gemini-3-flash
```

A **Model** card then appears on the Overview tab. Pick one and hit Apply; the
change takes effect on the very next message with no restart. The selection is
persisted to `dashboard_settings.db`, so you can leave `OPENAI_MODEL` commented
out and drive the model entirely from the dashboard.

The switcher only accepts models from `DASHBOARD_MODEL_OPTIONS`, so a typo is
rejected with an error instead of silently wedging the bot on a bad model. If
you leave the list empty the card is read-only and the model stays fixed by the
environment.

Notes on how the switch propagates:

- Provider routing updates too — selecting a Gemini model switches the bot from
  the OpenAI client to Google GenAI (provided `GEMINI_API_KEY` is set), and
  thinking/reasoning configuration follows the new model.
- "Revert to env model" clears the override and restores whatever
  `OPENAI_MODEL` resolves to. If `OPENAI_MODEL` is unset, that is the built-in
  `gpt-4o-mini` default, which the UI flags in amber so a revert is never a
  surprise.

**Configuration**

```env
DASHBOARD_ENABLED=true
DASHBOARD_HOST=127.0.0.1      # use 0.0.0.0 to reach it from other devices
DASHBOARD_PORT=3001
DASHBOARD_PASSWORD=           # required when HOST is not loopback
DASHBOARD_USERNAME=admin
DASHBOARD_LOG_WINDOW_HOURS=12
DASHBOARD_USAGE_WINDOW_HOURS=24
LLM_DAILY_REQUEST_LIMIT=500   # your provider's requests-per-day ceiling
DASHBOARD_MODEL_OPTIONS=gpt-4o,kimi-k2-thinking   # enables the live model switcher
```

**Security note:** the dashboard serves full prompts, responses, and stored
memories, so it is protected with HTTP Basic auth as soon as `DASHBOARD_PASSWORD`
is set. If you bind it to `0.0.0.0` the server **refuses to start** without a
password, to avoid exposing that data to your local network. Keep the default
`127.0.0.1` and access it only from the device running the bot.

**Request counting:** the requests-per-day counter is persisted in
`api_usage.db`, so a bot restart does not reset it. Every outbound LLM request
is counted, including tool-call follow-up rounds, streaming calls, and retries.
Use the dashboard's **Reset API counter** button (or `/api/usage/reset`) to start
a fresh window.

**Storage:** memories move to a new `user_memory_entries` table on first boot so
individual memories can be edited or deleted. The migration runs once inside a
transaction and is tracked in `schema_migrations`; existing memories are carried
over automatically. `bun run wipe-memories` and `bun run reattribute-memories`
both understand the new table.

### Reattributing an account's stored memories

If someone changes Discord accounts, stop the bot and preview the migration first:

```bash
bun run reattribute-memories OLD_DISCORD_USER_ID NEW_DISCORD_USER_ID
```

If the preview has no conflicts, apply it with `--force`. The script backs up the
three affected databases before moving long-term memories, conversation history,
and boredom settings. It refuses to guess how to merge existing target memories
or per-guild boredom settings; resolve those conflicts manually first.

## Project Structure

```
LumiaBot/
├── src/
│   ├── bot/
│   │   └── client.ts          # Discord client setup
│   ├── commands/
│   │   ├── chat.ts            # /chat command
│   │   ├── ratelimit.ts       # /ratelimit command (owner/mod)
│   │   └── search.ts          # /search command
│   ├── scripts/
│   │   └── register-commands.ts # Command registration script
│   ├── server/
│   │   ├── dashboard.ts       # Dashboard HTTP server (Bun.serve)
│   │   └── dashboard/
│   │       └── index.html     # Mobile-first dashboard UI
│   ├── services/
│   │   ├── openai.ts          # OpenAI integration
│   │   ├── api-usage.ts       # Rolling LLM request counter (RPD)
│   │   ├── dashboard-logger.ts # Rolling prompt/response log
│   │   ├── rate-limiter.ts    # Per-user chat rate limiting
│   │   └── searxng.ts         # SearXNG search integration
│   ├── utils/
│   │   └── config.ts          # Configuration management
│   └── index.ts               # Entry point
├── .env                       # Environment variables
├── .env.example               # Example environment file
├── package.json
├── tsconfig.json
└── README.md
```

## Upgrading

### Databases moved into `data/`

Every SQLite file used to be opened with a bare CWD-relative name
(`new Database('user_memories.db')`). That worked, but it meant the databases
lived next to whichever directory you started the bot from — start it somewhere
else and Bun quietly creates a brand-new empty file and uses *that*. All paths
are now anchored to the repository instead, and the databases live in `data/`
by default (override with `DATA_DIR`).

**Read this before your first start after upgrading.** Because SQLite creates a
missing file rather than failing, the upgrade itself will not error. It will
simply come up with an empty memory store and an empty knowledge base while
your real data sits in the old location looking untouched.

So, on the first run after pulling this change, the bot checks for each known
database at its old CWD-relative location and prints a loud warning naming every
file it found there and not in `data/`. If you see that warning:

```bash
# Option 1 — move the databases into the new location
mv ./user_memories.db ./conversations.db ./guild_memories.db \
   ./knowledge_graph.db ./api_usage.db ./boredom.db \
   ./dashboard_settings.db ./data/

# Option 2 — leave them where they are and point DATA_DIR at their parent
echo 'DATA_DIR=.' >> .env
```

Nothing is moved or deleted automatically. A file that exists in *both* places
is treated as a deliberate copy and is not reported, and a wrong automatic move
could clobber the copy you meant to keep.

The check runs once per process, on the first database open, and is a no-op on
every subsequent start.

### Crashes no longer stop the bot

`uncaughtException` and `unhandledRejection` are now logged and the process
**continues** instead of exiting. This is a deliberate
availability-over-crash-safety trade: for an interactive bot, dying mid-turn is
worse than surviving a degraded one. The trade-off is real, though — after an
uncaught exception the process state is not guaranteed to be consistent, so run
the bot under a supervisor (`systemd`, Docker with `restart: unless-stopped`,
`tmux`) and watch the logs for `🚨 [FATAL-GUARD]`. If you would rather have the
old fail-fast behaviour, the two handlers are `installProcessGuards()` in
`src/index.ts`.

## Development

### Running the tests

```bash
bun test
```

The suite is safe to run against a live deployment. `bunfig.toml` preloads
`src/__tests__/setup.ts` before any test module is evaluated, which points
`DATA_DIR` at a throwaway directory under the system temp dir. That matters
because several services open, migrate and sweep their SQLite file as a
**module-load side effect**, so without it merely *collecting* a test file would
run migrations and a retention `DELETE` against the real databases. Any
`DATA_DIR` you have exported in your shell is overridden for the duration of the
run and restored on exit.

`src/__tests__/test-isolation.test.ts` asserts this, plus the laziness of the
orchestrator turn journal, so a regression fails the suite rather than quietly
touching production data.

### Adding New Commands

1. Create a new file in `src/commands/`:
```typescript
import { SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js';
import type { Command } from '../bot/client';

const command: Command = {
  data: new SlashCommandBuilder()
    .setName('mycommand')
    .setDescription('Description of my command'),
  
  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.reply('Hello from my command!');
  },
};

export default command;
```

2. Register the command:
```bash
bun run register-commands
```

### Environment Variables

All configuration is managed through environment variables. See `.env.example` for all available options.

## Bot Personality Configuration

The bot's personality is defined in the `prompt_storage/` directory, which is **excluded from git** for privacy. You must create these files yourself using the provided templates.

### Setting Up Bot Definitions

1. **Create the directory structure:**
```bash
mkdir -p prompt_storage/persona prompt_storage/instructions prompt_storage/config
```

2. **Copy example templates:**
```bash
cp -r prompt_storage.example/* prompt_storage/
```

3. **Customize the files** to create your own bot personality (see `BOT_SETUP.md` for detailed instructions)

4. **Restart the bot** to load your custom personality

### Why This Approach?

The `prompt_storage/` directory is gitignored to keep your bot's unique personality private. The example templates in `prompt_storage.example/` show you the required file structure and format without exposing any proprietary content.

### File Structure

```
prompt_storage/
├── persona/
│   ├── identity.txt           # Main bot personality/system prompt
│   ├── boredom_pings.json     # Random messages when bot is "bored"
│   ├── error_templates.json   # Error/fallback responses
│   └── command_responses.json # Command-specific responses
├── instructions/
│   ├── video_reaction.txt     # How to react to videos
│   ├── reply_context.json     # Reply conversation templates
│   ├── memory_system.txt      # Memory formation instructions
│   └── boredom_updates.txt    # Boredom opt-in/opt-out responses
└── config/
    ├── triggers.json          # Bot trigger keywords
    └── tool_descriptions.json # Tool descriptions with personality
```

See `BOT_SETUP.md` for complete documentation on creating and customizing these files.

## Message Triggers

The bot automatically responds to messages when:

1. **Mentioned directly** - `@BadKittyBot hello!`
2. **Trigger keywords detected** - Messages containing:
   - `Bad Kitty` (case insensitive)
   - `Lumia` (case insensitive)
3. **Replied to** — replies to their messages

### Examples

```
@BadKittyBot What's the weather today?
→ Bot responds with AI-generated answer

Hey Bad Kitty, can you help me with something?
→ Bot responds with AI-generated answer

Lumia, what do you think about this?
→ Bot responds with AI-generated answer
```

### How it Works

- The bot monitors all messages in channels it has access to
- When triggered, it extracts the actual message content (removing the trigger)
- Generates an AI response using the bot's personality from `prompt_storage/persona/identity.txt`
- Replies directly to the user's message

**Note:** Message triggers do not use web search by default (unlike the `/chat` command with `search: true`).

### Reasoning Content Filtering

The bot automatically filters out reasoning content from AI models that include it (such as o1, o3, DeepSeek-R1, etc.). This prevents internal "thinking" from being shown to users.

**Filtered patterns include:**
- `<think>...</think>` tags
- `<reasoning>...</reasoning>` tags
- `[REASONING]...[/REASONING]` tags
- Lines starting with "reasoning:", "thinking:", etc.

To disable filtering, set:
```env
OPENAI_FILTER_REASONING=false
```

## Troubleshooting

### Bot not responding to commands
- Ensure you've registered commands with `bun run register-commands`
- Check that the bot has proper permissions in the Discord server
- Verify the bot token is correct

### Bot only reacts and does not reply
- The user hit the chat rate limit. Check with `/ratelimit status`
- Exempt the user by adding their role to `RATE_LIMIT_EXEMPT_ROLES`, or widen
  the window with `/ratelimit set <seconds>`

### Dashboard will not start
- `DASHBOARD_PORT` is already in use — set a different port
- The server refuses to bind a non-loopback `DASHBOARD_HOST` without
  `DASHBOARD_PASSWORD`; set the password or use the default `127.0.0.1`
- The browser prompts for a username/password when `DASHBOARD_PASSWORD` is set
  (default username is `admin`)

### Owner-only commands are denied for everyone
- Check the boot log for `🚨 OWNER_ID is not set`. Both `validateConfig()` and the
  startup banner warn when the owner is missing, and `/ratelimit set`, `/boredom`
  and memory wipes then deny without an error, so it looks like a permissions bug
- Set `OWNER_ID` to your Discord user id. `BOT_OWNER_ID` still works as a
  deprecated fallback, but `OWNER_ID` wins when both are set
- To share access, list numeric role IDs in `TRUSTED_ROLE_IDS` rather than
  adding a second name-based role to `RATE_LIMIT_EXEMPT_ROLES`

### OpenAI errors
- Check your API key is valid and has available credits
- Verify the model name is correct
- Check rate limits haven't been exceeded

### SearXNG errors
- Ensure the SearXNG URL is accessible
- Check if the instance requires authentication
- Verify the instance supports JSON output format

## License

MIT

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.
