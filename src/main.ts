import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { HubBot } from "./bot";
import { loadConfig } from "./config";
import { DiscordGateway } from "./discord-gateway";
import { acquireLock } from "./lock";
import { MessageStore } from "./store";

const INBOX_MAX_AGE_SECONDS = 86_400;
const log = (event: string) => console.error(JSON.stringify({ time: new Date().toISOString(), event }));

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const release = acquireLock(join(config.dataDir, "bot.lock"));
  let store: MessageStore | undefined;
  let bot: HubBot | undefined;
  let shutdownTask: Promise<void> | undefined;
  const shutdown = (failed: boolean): Promise<void> => {
    shutdownTask ??= (async () => {
      try {
        await bot?.stop(failed);
      } finally {
        try { store?.close(); } finally { release(); }
      }
    })();
    return shutdownTask;
  };
  const onSignal = () => {
    void shutdown(false).then(() => process.exit(0), () => process.exit(1));
  };
  try {
    store = new MessageStore(join(config.dataDir, "state.sqlite"));
    // 本文は処理待ちの間だけ持つ。取り残しも 1 日で消す。
    const opened = store;
    opened.purge(INBOX_MAX_AGE_SECONDS);
    setInterval(() => { try { opened.purge(INBOX_MAX_AGE_SECONDS); } catch { log("inbox_purge_failed"); } }, 3_600_000).unref();
    bot = new HubBot(new DiscordGateway(), store, {
      channelIds: config.channelIds,
      healthPath: join(config.dataDir, "health.json"),
      log,
      onFatal: () => { void shutdown(true).finally(() => process.exit(1)); },
    });
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    await bot.start(config.discordToken);
  } catch {
    await shutdown(true);
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    throw new Error("Bot initialization failed");
  }
}

if (import.meta.main) {
  main().catch(() => {
    // Never log raw SDK errors, tokens, request URLs, or message contents.
    log("bot_start_failed");
    process.exit(1);
  });
}
