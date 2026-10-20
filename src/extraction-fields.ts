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

export const MAX_TITLE_LENGTH = 80;
const QUOTED = /^(?:「([^「」『』"“”]+)」|『([^「」『』"“”]+)』|"([^「」『』"“”]+)"|“([^「」『』"“”]+)”)$/;
const INLINE_QUOTED = /^[^「」『』"“”]*(?:「([^「」『』"“”]+)」|『([^「」『』"“”]+)』)[^「」『』"“”]*$/;
const LABELLED = /^(?:題名|タイトル|演題|title)(?:\s*[:：]\s*|\s+)(.+)$/i;
// 行の途中のラベル。文中の引用を題名として採る前に、ラベル付きの題名と食い違わないか見る。
const EMBEDDED_LABEL = /(?:題名|タイトル|演題|title)(?:\s*[:：]|\s+[^\s「」『』"“”])/i;
const PLAIN_FORBIDDEN = /[。．.!?！？、，,「」『』"“”]/;
const UNSAFE = /https?:\/\/|<@|@everyone|@here/i;

const quotedTitle = (text: string, pattern = QUOTED): string | undefined => {
  const match = pattern.exec(text);
  return match?.slice(1).find(group => group !== undefined)?.trim();
};

/** 題名を明示した行だけを見る。『題名』のスライドです、などの続報の引用は除く。 */
export function hasTitleLine(content: string): boolean {
  return content.split(/\r?\n/).some(line => {
    const text = line.trim().replace(/。$/, "").trim();
    return QUOTED.test(text) || LABELLED.test(text) || EMBEDDED_LABEL.test(text)
      || /(?:題名|タイトル|演題)\s*は\s*\S/.test(text)
      || /(?:題名|タイトル|演題|title)\s*[「『"“]/i.test(text);
  });
}

/**
 * 選ばれた行から題名だけを切り出す。次の規則に一致しなければ undefined（review）。
 * (a)「X」『X』"X"“X” (b) ラベル＋区切り＋X（X に句点・終止符・引用符なし） (c) ラベル＋区切り＋引用。
 * (d) ラベル＋区切りがなく、行の中に「X」または『X』が 1 組だけある時は、その中身を採る。
 * 判定の前に前後の空白と末尾の「。」1 つだけを除く。
 */
export function extractTitle(line: string): string | undefined {
  const text = line.trim().replace(/。$/, "").trim();
  const label = LABELLED.exec(text)?.[1]?.trim();
  const title = label === undefined
    ? quotedTitle(text) ?? (EMBEDDED_LABEL.test(text) ? undefined : quotedTitle(text, INLINE_QUOTED))
    : quotedTitle(label) ?? (PLAIN_FORBIDDEN.test(label) ? undefined : label);
  if (!title || [...title].length > MAX_TITLE_LENGTH || UNSAFE.test(title)) return undefined;
  return title;
}

export type DateResolution = { status: "resolved"; date: string }
  | { status: "unresolved"; reason: "missing" | "ambiguous" | "unmatched" };

export function validEventDate(date: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(`${date}T00:00:00Z`))
    && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date;
}

/**
 * 日付は日本時間の投稿日を基準に、Hub から渡された開催日だけに解決する。
 * 応募は投稿日以降の開催日に限る。続報（includePast）は過去の開催日とも照合する。「次回」は常に投稿日以降。
 */
export function resolveEventDate(
  content: string, dates: readonly string[], createdAt: string, { includePast = false } = {},
): DateResolution {
  const posted = Date.parse(createdAt);
  if (!Number.isFinite(posted)) return { status: "unresolved", reason: "unmatched" };
  const postedDay = new Date(posted + 9 * 3600_000).toISOString().slice(0, 10);
  const known = [...new Set(dates.filter(validEventDate))].sort();
  const upcoming = known.filter(date => date >= postedDay);
  const candidates = includePast ? known : upcoming;
  // URL 中の数字は開催日の指定として扱わない。
  const text = content.replace(/https?:\/\/\S+/g, "");
  const matches = [...text.matchAll(/(?<![\d/])(?:(\d{4})[\/年-])?(\d{1,2})[\/月-](\d{1,2})(?:日)?(?![\d/])/g)];
  if (matches.length > 0) {
    const selected = new Set<string>();
    for (const match of matches) {
      const [, year, month, day] = match;
      const found = candidates.filter(date => (!year || date.slice(0, 4) === year)
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
