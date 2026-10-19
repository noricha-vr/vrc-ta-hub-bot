import type { GatewayAttachment } from "./gateway";

export interface Material {
  kind: "slides" | "pdf";
  url: string;
}

export function httpUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (["https:", "http:"].includes(url.protocol) && !url.username && !url.password) return url.href;
  } catch { /* 不正な URL は資料にしない。 */ }
  return undefined;
}

export function extractMaterials(content: string, attachments: readonly GatewayAttachment[] = []): Material[] {
  const materials: Material[] = [];
  for (const line of content.split(/\r?\n/)) {
    for (const match of line.matchAll(/https?:\/\/[^\s<>"）)\]】]+/g)) {
      const url = httpUrl(match[0].replace(/[.,、。！？!?]+$/, ""));
      if (!url) continue;
      const path = new URL(url).pathname;
      if (/\.pdf$/i.test(path)) materials.push({ kind: "pdf", url });
      else if (/(?:資料|スライド|slides?|presentation)/i.test(line)
        || /\/(?:slides?|presentation|decks?)(?:\/|$)/i.test(path)) materials.push({ kind: "slides", url });
    }
  }
  for (const attachment of attachments) {
    const url = httpUrl(attachment.url);
    if (url && (/\.pdf$/i.test(attachment.name) || attachment.contentType?.split(";")[0] === "application/pdf")) {
      materials.push({ kind: "pdf", url });
    }
  }
  return mergeMaterials(materials);
}

export function mergeMaterials(...groups: readonly Material[][]): Material[] {
  const materials = new Map<string, Material>();
  for (const group of groups) for (const item of group) materials.set(item.url, { kind: item.kind, url: item.url });
  return [...materials.values()];
}

export type DateResolution = { status: "resolved"; date: string }
  | { status: "unresolved"; reason: "missing" | "ambiguous" | "unmatched" };

export function validEventDate(date: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(`${date}T00:00:00Z`))
    && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date;
}

/** 日付は日本時間の投稿日を基準に、ハブから渡された開催日だけに解決する。 */
export function resolveEventDate(content: string, dates: readonly string[], createdAt: string): DateResolution {
  const posted = Date.parse(createdAt);
  if (!Number.isFinite(posted)) return { status: "unresolved", reason: "unmatched" };
  const postedDay = new Date(posted + 9 * 3600_000).toISOString().slice(0, 10);
  const upcoming = [...new Set(dates.filter(date => validEventDate(date) && date >= postedDay))].sort();
  // URL 中の数字は開催日の指定として扱わない。
  const text = content.replace(/https?:\/\/\S+/g, "");
  const matches = [...text.matchAll(/(?<![\d/])(?:(\d{4})[\/年-])?(\d{1,2})[\/月-](\d{1,2})(?:日)?(?![\d/])/g)];
  if (matches.length > 0) {
    const selected = new Set<string>();
    for (const match of matches) {
      const [, year, month, day] = match;
      const found = upcoming.filter(date => (!year || date.slice(0, 4) === year)
        && Number(date.slice(5, 7)) === Number(month) && Number(date.slice(8, 10)) === Number(day));
      if (found.length === 0) return { status: "unresolved", reason: "unmatched" };
      for (const date of found) selected.add(date);
    }
    if (selected.size !== 1) return { status: "unresolved", reason: "ambiguous" };
    return { status: "resolved", date: [...selected][0]! };
  }
  if (/次回/.test(text)) return upcoming[0]
    ? { status: "resolved", date: upcoming[0] } : { status: "unresolved", reason: "unmatched" };
  return { status: "unresolved", reason: "missing" };
}
