import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { HubBot } from "./bot";
import { ConfigConflictError, loadConfigFile } from "./config";
import { DiscordGateway } from "./discord-gateway";
import { acquireLock, LockExistsError } from "./lock";
import { HubStore } from "./hub-store";
import { HubApi } from "./hub-api";
import { HubSetup } from "./hub-setup";
import { ExtractionStore } from "./extraction-store";
import { HubDeliveryStore } from "./hub-delivery-store";
import { HubReview } from "./hub-review";
import { HubPostReview } from "./hub-post-review";
import { HubPipeline } from "./hub-pipeline";
import { JevJudge } from "./jev";

// 1 時間ごとの削除の遅れを足しても 24 時間を超えないよう、期限は 23 時間にする。
export const INBOX_MAX_AGE_SECONDS = 23 * 3600;
// 失敗しても短い間隔で再試行し、期限＋周期が 24 時間を超えないようにする
export const INBOX_PURGE_INTERVAL_MS = 300_000;
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
// 端末やセッションを閉じた時の SIGHUP も正常停止にして、ロックを残さない。
export const SHUTDOWN_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
const log = (event: string, fields?: { keys?: string[]; reason?: string; lockHolderAlive?: boolean }) => console.error(JSON.stringify({ time: new Date().toISOString(), event, ...fields }));

/** mkdirSync の mode は既存のディレクトリに効かないので、起動ごとに権限をそろえる。 */
export function restrictDataPermissions(dataDir: string, dbPath: string): void {
  chmodSync(dataDir, DIR_MODE);
  for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    if (existsSync(path)) chmodSync(path, FILE_MODE);
  }
}

async function main(): Promise<void> {
  const config = loadConfigFile(process.env);
  mkdirSync(config.dataDir, { recursive: true, mode: DIR_MODE });
  chmodSync(config.dataDir, DIR_MODE);
  const release = acquireLock(join(config.dataDir, "bot.lock"));
  let store: HubStore | undefined;
  let bot: HubBot | undefined;
  let extracted: ExtractionStore | undefined;
  let deliveries: HubDeliveryStore | undefined;
  let shutdownTask: Promise<void> | undefined;
  const shutdown = (failed: boolean): Promise<void> => {
    shutdownTask ??= (async () => {
      try {
        await bot?.stop(failed);
      } finally {
        try { deliveries?.close(); } finally {
          try { extracted?.close(); } finally {
            try { store?.close(); } finally { release(); }
          }
        }
      }
    })();
    return shutdownTask;
  };
  const onSignal = () => {
    void shutdown(false).then(() => process.exit(0), () => process.exit(1));
  };
  try {
    const dbPath = join(config.dataDir, "state.sqlite");
    store = new HubStore(dbPath);
    extracted = new ExtractionStore(dbPath);
    deliveries = new HubDeliveryStore(dbPath);
    restrictDataPermissions(config.dataDir, dbPath);
    // 本文は処理待ちの間だけ持つ。取り残しも 1 日で消す。
    const opened = store;
    opened.purge(INBOX_MAX_AGE_SECONDS);
    setInterval(() => { try { opened.purge(INBOX_MAX_AGE_SECONDS); } catch { log("inbox_purge_failed"); } }, INBOX_PURGE_INTERVAL_MS).unref();
    const gateway = new DiscordGateway();
    const api = new HubApi(config.hubBaseUrl, config.hubApiKey);
    const posts = new HubPostReview(gateway, opened, extracted, api, log);
    const review = new HubReview(gateway, opened, extracted, deliveries, api, log, undefined, posts);
    const work = new HubPipeline(opened, extracted, gateway, new JevJudge(config.jevApiKey), api, review, log);
    const hub = new HubSetup(gateway, opened, api, () => bot?.refreshChannels(), log, Date.now, review);
    bot = new HubBot(gateway, store, {
      channelIds: () => opened.channelIds(),
      baseline: channelId => opened.baseline(channelId),
      hub,
      work,
      healthPath: join(config.dataDir, "health.json"),
      envFilePath: config.envFilePath,
      hubHost: new URL(config.hubBaseUrl).hostname,
      log,
      onFatal: () => { void shutdown(true).finally(() => process.exit(1)); },
    });
    // 停止を待つ間に同じシグナルが再び来ても既定の終了にならないよう、once でなく on で受け続ける。
    for (const signal of SHUTDOWN_SIGNALS) process.on(signal, onSignal);
    await bot.start(config.discordToken);
  } catch {
    await shutdown(true);
    for (const signal of SHUTDOWN_SIGNALS) process.off(signal, onSignal);
    throw new Error("Bot initialization failed");
  }
}

if (import.meta.main) {
  main().catch(error => {
    // Never log raw SDK errors, tokens, request URLs, or message contents.
    if (error instanceof ConfigConflictError) log("bot_config_conflict", { keys: error.keys });
    if (error instanceof LockExistsError) log("bot_start_failed", { reason: "lock_exists", lockHolderAlive: error.holderAlive });
    else log("bot_start_failed");
    process.exit(1);
  });
}
