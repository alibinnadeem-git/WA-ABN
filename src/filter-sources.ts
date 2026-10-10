import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

export type SourceKind = "image" | "vcard" | "document" | "audio" | "video" | "link" | "text";
export type SourceProcessing = "text_indexed" | "metadata_indexed" | "needs_extraction" | "lead_extracted";
export interface WhatsAppSource {
  id: string;
  groupJid: string;
  messageId: string;
  senderJid: string;
  kind: SourceKind;
  mimeType: string | null;
  fileName: string | null;
  caption: string;
  excerpt: string;
  contentHash: string | null;
  processing: SourceProcessing;
  capturedAt: string;
}

/** Process only extracted text plus bounded metadata, never persist original media bytes. */
export class FilterSourceRegistry {
  private items: WhatsAppSource[] = [];
  constructor(private readonly file: string) {
    if (existsSync(file)) {
      const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (!Array.isArray(parsed)) throw new Error("Invalid Filter CRM source registry");
      this.items = parsed as WhatsAppSource[];
    }
  }
  private persist(): void {
    const temp = this.file + "." + process.pid + ".tmp";
    writeFileSync(temp, JSON.stringify(this.items, null, 2), { mode: 0o600 });
    renameSync(temp, this.file);
  }
  record(info: Omit<WhatsAppSource,"id" | "capturedAt" | "contentHash" | "excerpt"> & {
    body?: Buffer | null;
    extractedText?: string | null;
  }): WhatsAppSource {
    const existing = this.items.find((s) => s.groupJid === info.groupJid && s.messageId === info.messageId && s.kind === info.kind);
    if (existing) return existing;
    const body = info.body ?? null;
    const item: WhatsAppSource = {
      id: randomUUID(),
      groupJid: info.groupJid,
      messageId: info.messageId,
      senderJid: info.senderJid,
      kind: info.kind,
      mimeType: info.mimeType?.slice(0,100) ?? null,
      fileName: info.fileName?.slice(0,200) ?? null,
      caption: info.caption.slice(0,2000),
      excerpt: info.extractedText?.slice(0,8000) ?? "",
      contentHash: body ? createHash("sha256").update(body).digest("hex") : null,
      processing: info.processing,
      capturedAt: new Date().toISOString(),
    };
    this.items.push(item);
    this.persist();
    return item;
  }
  markLeadExtracted(groupJid: string, messageId: string): void {
    const matching = this.items.filter((s) => s.groupJid === groupJid && s.messageId === messageId);
    if (!matching.length) return;
    for (const s of matching) s.processing = "lead_extracted";
    this.persist();
  }
  forGroup(groupJid: string, limit=15): WhatsAppSource[] {
    return this.items.filter((s)=>s.groupJid===groupJid).slice(-Math.min(Math.max(limit,1),100)).reverse();
  }
  getForGroup(id: string, groupJid: string): WhatsAppSource | null {
    return this.items.find((s)=>s.groupJid===groupJid && (s.id === id || s.id.startsWith(id))) ?? null;
  }
}

/** Safe support for plain textual attachments; PDF/Office, audio and video are not silently OCRed. */
export function safeSourceText(bytes: Buffer, mimeType: string): string | null {
  if (!["text/plain","text/csv","text/vcard","application/json"].includes(mimeType.toLowerCase())) return null;
  if (bytes.length > 1024 * 1024 || bytes.includes(0)) return null;
  return bytes.toString("utf8").slice(0,8000);
}

export function sourceSummary(source: WhatsAppSource): string {
  const name = source.fileName || source.kind;
  return `• ${name} · ${source.processing} · ${source.capturedAt}\n  ID: ${source.id}`;
}
