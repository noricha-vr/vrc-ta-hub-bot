import { renameSync, writeFileSync } from "node:fs";
import type { NotificationTarget } from "./hub-store";

export type ConnectionState = "connecting" | "connected" | "disconnected" | "reconnecting" | "error" | "stopped";

export interface Health {
  envFilePath: string | null;
  hubHost: string | null;
  startedAt: string;
  updatedAt: string;
  lastReceivedAt: string | null;
  connectionState: ConnectionState;
  reconnectCount: number;
  recoveredMessageCount: number;
  pendingChannelCount: number;
  pendingReviewCount: number;
  pendingPostReviewCount: number;
  unknownPostReviewNotificationCount: number;
  rejectedPostReviewNotificationCount: number;
  rejectedPostReviewNotificationTargets: NotificationTarget[];
  oldestPendingReviewAgeSeconds: number;
  lastSuccessfulSyncAt: string | null;
  lastErrorAt: string | null;
}

export function writeHealth(path: string, health: Health): void {
  const temporaryPath = `${path}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(health, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporaryPath, path);
}
