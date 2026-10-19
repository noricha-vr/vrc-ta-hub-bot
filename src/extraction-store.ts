import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mergeMaterials, type Material } from "./extraction-fields";

export interface PostReference {
  messageId: string;
  channelId: string;
  url: string;
}

export interface TalkDraft {
  id: string;
  meetingId: string;
  presenterId: string;
  presenterName: string;
  eventDate: string;
  title: string;
  materials: Material[];
  sources: PostReference[];
}

export type NewTalkDraft = Omit<TalkDraft, "id" | "sources">;
export type SavedDraft = { status: "candidate"; action: "created" | "updated"; draft: TalkDraft }
  | { status: "duplicate"; draft: TalkDraft };

interface DraftRow {
  id: string;
  meeting_id: string;
  presenter_id: string;
  presenter_name: string;
  event_date: string;
  title: string;
  materials: string;
}

/** 抽出済みの項目と出典だけを保存する。受信箱とは独立し、本文の列を持たない。 */
export class ExtractionStore {
  private readonly db: Database;

  constructor(path: string) {
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS talk_drafts (
        id TEXT PRIMARY KEY,
        meeting_id TEXT NOT NULL,
        presenter_id TEXT NOT NULL,
        presenter_name TEXT NOT NULL,
        event_date TEXT NOT NULL,
        title TEXT NOT NULL,
        materials TEXT NOT NULL,
        UNIQUE (meeting_id, presenter_id, event_date)
      );
      CREATE TABLE IF NOT EXISTS talk_sources (
        message_id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        source_url TEXT NOT NULL,
        draft_id TEXT NOT NULL REFERENCES talk_drafts(id)
      );
    `);
  }

  get(id: string): TalkDraft | undefined {
    const row = this.db.query<DraftRow, [string]>("SELECT * FROM talk_drafts WHERE id = ?").get(id);
    if (!row) return undefined;
    const sources = this.db.query<{ message_id: string; channel_id: string; source_url: string }, [string]>(
      "SELECT message_id, channel_id, source_url FROM talk_sources WHERE draft_id = ? ORDER BY rowid",
    ).all(id).map(source => ({ messageId: source.message_id, channelId: source.channel_id, url: source.source_url }));
    return {
      id: row.id, meetingId: row.meeting_id, presenterId: row.presenter_id, presenterName: row.presenter_name,
      eventDate: row.event_date, title: row.title, materials: JSON.parse(row.materials) as Material[], sources,
    };
  }

  forPresenter(meetingId: string, presenterId: string): TalkDraft[] {
    return this.db.query<{ id: string }, [string, string]>(
      "SELECT id FROM talk_drafts WHERE meeting_id = ? AND presenter_id = ? ORDER BY event_date, id",
    ).all(meetingId, presenterId).map(row => this.get(row.id)!);
  }

  forMessage(messageId: string): TalkDraft | undefined {
    const row = this.db.query<{ draft_id: string }, [string]>(
      "SELECT draft_id FROM talk_sources WHERE message_id = ?",
    ).get(messageId);
    return row ? this.get(row.draft_id) : undefined;
  }

  create(fields: NewTalkDraft, source: PostReference): SavedDraft {
    return this.db.transaction((): SavedDraft => {
      const prior = this.forMessage(source.messageId);
      if (prior) return { status: "duplicate", draft: prior };
      const sameTalk = this.db.query<{ id: string }, [string, string, string]>(
        "SELECT id FROM talk_drafts WHERE meeting_id = ? AND presenter_id = ? AND event_date = ?",
      ).get(fields.meetingId, fields.presenterId, fields.eventDate);
      if (sameTalk) {
        this.addSource(sameTalk.id, source);
        return { status: "duplicate", draft: this.get(sameTalk.id)! };
      }
      const id = randomUUID();
      this.db.query(`INSERT INTO talk_drafts
        (id, meeting_id, presenter_id, presenter_name, event_date, title, materials) VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(id, fields.meetingId, fields.presenterId, fields.presenterName, fields.eventDate, fields.title,
        JSON.stringify(mergeMaterials(fields.materials)));
      this.addSource(id, source);
      return { status: "candidate", action: "created", draft: this.get(id)! };
    }).immediate();
  }

  /** 現在値をトランザクション内で読み直し、並行した続報の資料も失わない。 */
  addFollowUp(id: string, materials: Material[], source: PostReference): SavedDraft {
    return this.db.transaction((): SavedDraft => {
      const prior = this.forMessage(source.messageId);
      if (prior) return { status: "duplicate", draft: prior };
      const draft = this.get(id);
      if (!draft) throw new Error("Draft no longer exists");
      this.db.query("UPDATE talk_drafts SET materials = ? WHERE id = ?")
        .run(JSON.stringify(mergeMaterials(draft.materials, materials)), id);
      this.addSource(id, source);
      return { status: "candidate", action: "updated", draft: this.get(id)! };
    }).immediate();
  }

  private addSource(id: string, source: PostReference): void {
    this.db.query("INSERT INTO talk_sources (message_id, channel_id, source_url, draft_id) VALUES (?, ?, ?, ?)")
      .run(source.messageId, source.channelId, source.url, id);
  }

  counts(): { drafts: number; sourcePosts: number } {
    return {
      drafts: this.db.query<{ n: number }, []>("SELECT count(*) AS n FROM talk_drafts").get()!.n,
      sourcePosts: this.db.query<{ n: number }, []>("SELECT count(*) AS n FROM talk_sources").get()!.n,
    };
  }

  close(): void { this.db.close(); }
}
