# Bot Personality Templates

This directory contains example templates for creating your bot's personality. These are generic starting points - customize them to create your unique bot character!

## Quick Setup

1. Copy these files to `../prompt_storage/`:
   ```bash
   cp -r prompt_storage.example/* ../prompt_storage/
   ```

2. Edit the files to match your desired bot personality

3. Restart your bot

## File Overview

### Required Files

- **persona/identity.txt** - The main system prompt defining your bot's personality
- **config/triggers.json** - Keywords that activate your bot

### Optional Files

- **persona/boredom_pings.json** - Random messages for idle users
- **persona/error_templates.json** - Error messages in your bot's voice
- **persona/command_responses.json** - Responses to specific commands
- **instructions/video_reaction.txt** - How to react to videos
- **instructions/memory_system.txt** - Memory formation guidelines
- **instructions/reply_context.json** - Reply context templates
- **instructions/boredom_updates.txt** - Opt-in/opt-out messages
- **config/tool_descriptions.json** - Tool descriptions with personality

### Shape of these two JSON files

`persona/command_responses.json` must be a **single** JSON object. It was once
shipped as two objects concatenated together (`},` then `{`), which is not valid
JSON: the loader swallows the parse error and every canned command reply
silently answers with nothing.

`config/tool_descriptions.json` must be keyed by the **exact tool name the bot
registers** (`web_search`, `search_users`, `generate_selfie`, ... - the names in
`src/services/openai.ts` and `src/services/google-genai.ts`). The prompt loader
reads these keys without a guard, so a missing key is not a degraded feature, it
is a crash the first time anything asks for tool descriptions. If you add a tool
to either provider, add its entry here in the same change.

Two keys are read by the prompt layer rather than registered as tools, and must
stay even though they are not tool names:

- `boredom_preference` - `description`, `trigger_phrases_opt_in`,
  `trigger_phrases_opt_out`, `note`. The absence of this key is the crash.
- `query_knowledge_base` - the prompt layer's alias for the live
  `search_knowledge_base` tool.

## Customization Tips

1. **Start with identity.txt** - This is the most important file
2. **Edit triggers.json** - Set your bot's name and activation words
3. **Test iteratively** - Make small changes and see how they affect responses
4. **Keep backups** - Save versions that work well

## Template Variables

Use these variables in your files (they'll be replaced at runtime):

- `{botName}` - Your bot's name
- `{ownerName}` - The bot owner's name
- `{ownerId}` - Owner's Discord ID
- `{ownerUsername}` - Owner's Discord username
- `{userId}` - Target user's Discord ID

See `../BOT_SETUP.md` for complete documentation.
