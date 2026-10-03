import { bot } from './bot/client';
import { validateConfig, config, isMoonshotProvider } from './utils/config';
import { loadBotDefinition } from './utils/bot-definition';
import { setTemplateVariables } from './services/prompts';
import { initBalance } from './services/moonshot';
import { knowledgeGraphService } from './services/knowledge-graph';
import { modelSelectorService } from './services/model-selector';
import { startDashboardServer, type DashboardServer } from './server/dashboard';
import { startHealthServer, type HealthServer } from './server/health';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Events } from 'discord.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = fileURLToPath(new URL('.', import.meta.url));

async function loadCommands() {
  const commandsPath = join(__dirname, 'commands');
  const commandFiles = readdirSync(commandsPath).filter(file => file.endsWith('.ts'));

  for (const file of commandFiles) {
    const filePath = join(commandsPath, file);
    const command = await import(filePath);
    
    if ('default' in command && command.default.data && command.default.execute) {
      bot.commands.set(command.default.data.name, command.default);
      console.log(`Registered command: ${command.default.data.name}`);
    }
  }
}

/**
 * Process-level crash guards.
 *
 * WHY THE BOT SURVIVES INSTEAD OF EXITING — read this before "fixing" it.
 *
 * Bun (like Node with `--unhandled-rejections=throw`, the default since Node 15)
 * treats an unhandled promise rejection as a fatal error and terminates the
 * process. This bot is a long-running, interactive service: it holds one Discord
 * gateway connection, an orchestrator WebSocket, and a per-channel work queue. A
 * single turn that throws somewhere without a local `catch` — a malformed
 * attachment, a deleted channel, a transient REST fault, a `discarded .finally()`
 * on a rejected promise — would otherwise take down every other guild, every
 * in-flight generation, and the operator's ability to talk to the bot, with no
 * supervisor restart in between.
 *
 * The correct behaviour for a service like this is to log loudly with full context
 * and keep serving. The `try`/`catch` blocks inside the event handlers fix the
 * known throw sites; these handlers are the backstop for the ones nobody has found
 * yet, and for third-party code (discord.js, the `ws` client, ffmpeg) that
 * rejects on its own.
 *
 * A supervisor/systemd unit is still the right place to restart on a genuinely
 * wedged process; this is not a substitute for that, it is what stops a single
 * bad message from being an outage.
 */
function installProcessGuards(): void {
  process.on('unhandledRejection', (reason) => {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    console.error('🚨 [FATAL-GUARD] Unhandled promise rejection (continuing):', {
      name: error.name,
      message: error.message,
      stack: error.stack,
    });
  });

  process.on('uncaughtException', (error, origin) => {
    // Note the honest caveat: after an uncaught exception the process state is not
    // guaranteed consistent. Continuing is still the right trade for this service,
    // because an interactive bot that dies mid-conversation is worse than one that
    // survives with a degraded turn. The supervisor remains the backstop.
    console.error('🚨 [FATAL-GUARD] Uncaught exception (continuing):', {
      name: error.name,
      message: error.message,
      stack: error.stack,
      origin,
    });
  });
}

/**
 * The single owner of process shutdown.
 *
 * SIGINT/SIGTERM used to be registered in two places — `DiscordBot`'s constructor
 * and here — so one signal ran both handlers: two concurrent `bot.destroy()` calls
 * racing each other, and two `process.exit(0)` calls. Worse, the client-side
 * handlers did `this.destroy().then(() => process.exit(0))` with no `.catch()`, so
 * a rejecting `destroy()` during shutdown became an unhandled rejection. This is
 * the only place that reacts to a signal, it is idempotent, and every exit path
 * is guarded.
 *
 * Both HTTP listeners (dashboard and health) are released here, each in its own
 * `try`/`catch`: leaving a bound socket behind is what makes a restart fail to
 * rebind, and neither listener is worth a refusal to exit over.
 */
function installShutdownHandlers(
  getDashboard: () => DashboardServer | null,
  getHealth: () => HealthServer | null,
  intervals: Timer[]
): void {
  let shuttingDown = false;

  const shutdown = (signal: string) => {
    if (shuttingDown) {
      console.log(`[SHUTDOWN] ${signal} received again; already shutting down.`);
      return;
    }
    shuttingDown = true;
    console.log(`\n🛑 [SHUTDOWN] ${signal} received, shutting down gracefully...`);

    for (const interval of intervals) {
      clearInterval(interval);
    }

    try {
      getDashboard()?.stop(true);
    } catch (error) {
      console.error('[SHUTDOWN] Dashboard stop failed (continuing):', error);
    }

    try {
      getHealth()?.stop(true);
    } catch (error) {
      console.error('[SHUTDOWN] Health stop failed (continuing):', error);
    }

    // Guarded exit: a failure to tear down must not become an unhandled rejection
    // on the way out, and must not leave the process hanging either.
    bot.destroy()
      .catch((error) => {
        console.error('[SHUTDOWN] bot.destroy() failed (continuing):', error);
      })
      .finally(() => {
        console.log('[SHUTDOWN] Shutdown complete.');
        process.exit(0);
      });
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

async function main() {
  let dashboard: DashboardServer | null = null;
  let health: HealthServer | null = null;
  const backgroundIntervals: Timer[] = [];

  // Installed first, before anything can throw, so a failure during startup is
  // still reported rather than silently killing the process.
  installProcessGuards();

  try {
    // Validate environment configuration
    validateConfig();
    console.log('Configuration validated successfully');

    // Apply bot template variables from environment
    setTemplateVariables({
      botName: config.bot.name,
      botFamily: config.bot.familyName,
      bot_family: config.bot.familyName,
      councilName: config.orchestrator.councilName,
      ownerName: config.bot.ownerName,
      // `config.bot.ownerId` is the EMPTY STRING when neither OWNER_ID nor
      // BOT_OWNER_ID is set. `setTemplateVariables` filters out `undefined` but
      // not `''`, so passing the empty string would inject a literal blank into
      // every prompt that references the owner. `|| undefined` keeps the template
      // variable unset instead, which is the honest representation.
      ownerId: config.bot.ownerId || undefined,
      ownerUsername: config.bot.ownerUsername,
    });
    console.log(`Bot configured as: ${config.bot.name}`);

    // Loud, unmissable startup warning. `validateConfig()` already warns, but this
    // is restated at the point the owner id is consumed because the failure mode is
    // silent: with no OWNER_ID, every owner-only command (memory wipes, global
    // config changes, `/ratelimit`, `/boredom`) denies *everyone*, including the
    // operator, with a message that looks like a permissions problem rather than a
    // missing environment variable.
    if (!config.bot.ownerIdSet) {
      console.warn(
        '\n' +
          '='.repeat(72) + '\n' +
          '🚨 OWNER_ID IS NOT SET — owner-only features are DISABLED.\n' +
          '     Set OWNER_ID (or BOT_OWNER_ID) to your Discord user id.\n' +
          '     Until then every owner-only command silently denies, for you too.\n' +
          '     There is deliberately no default owner id.\n' +
          '='.repeat(72) + '\n',
      );
    }

    // Load bot definition from bot.txt
    loadBotDefinition();

    // Fetch baseline Moonshot balance if applicable
    if (isMoonshotProvider()) {
      await initBalance();
    }

    // Sync knowledge documents from disk
    await knowledgeGraphService.syncFromFiles();

    // Apply the persisted dashboard model selection (if any) before serving traffic
    const modelState = modelSelectorService.getState();
    console.log(`🎛️ [MODEL] Active model: ${modelState.active} (source: ${modelState.source})`);
    if (!modelState.canChange) {
      console.log('🎛️ [MODEL] Live model switching disabled (set DASHBOARD_MODEL_OPTIONS to enable it)');
    }

    // Load commands
    await loadCommands();
    console.log('Commands loaded successfully');

    // Start the bot
    await bot.login();
    console.log('Bot started successfully');

    // Start the mobile dashboard (observability + memory management)
    dashboard = startDashboardServer();

    // Monitor-facing liveness port (opt-in via HEALTH_PORT). Separate listener on
    // purpose: a monitor cannot authenticate, and sharing the dashboard's port
    // meant its unauthenticated polls counted as failed logins and eventually
    // locked the operator out of the dashboard itself.
    health = startHealthServer();

    // Note: Guild updates are now handled by the onConnect callback in the orchestrator
    // This ensures guilds are sent immediately after the WebSocket connection is established

    // Handle guild join/leave events for orchestrator
    bot.client.on(Events.GuildCreate, (guild) => {
      console.log(`[Orchestrator] Joined guild: ${guild.name} (${guild.id})`);
      bot.updateOrchestratorGuilds();
    });

    bot.client.on(Events.GuildDelete, (guild) => {
      console.log(`[Orchestrator] Left guild: ${guild.name} (${guild.id})`);
      bot.updateOrchestratorGuilds();
    });

    // Periodic guild sync every 5 minutes to ensure orchestrator has latest data.
    //
    // The handle is retained so shutdown can clear it, and `unref()`'d so this
    // housekeeping timer can never be the reason the process stays alive. It was
    // previously a bare `setInterval` that nothing ever cleared, which was only
    // harmless because `process.exit(0)` fired right after.
    const guildSyncInterval = setInterval(() => {
      if (bot.client.isReady()) {
        const status = bot.getOrchestratorStatus();
        if (status?.isConnected) {
          console.log('[Orchestrator] Periodic guild sync check...');
          bot.updateOrchestratorGuilds();
        }
      }
    }, 5 * 60 * 1000);
    guildSyncInterval.unref?.();
    backgroundIntervals.push(guildSyncInterval);

    // Single, idempotent, fully-guarded shutdown path.
    installShutdownHandlers(() => dashboard, () => health, backgroundIntervals);

  } catch (error) {
    console.error('Failed to start bot:', error);
    process.exit(1);
  }
}

main();
