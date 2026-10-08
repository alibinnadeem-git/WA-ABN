import { google } from "googleapis";
import { config } from "./config.js";

const auth = new google.auth.GoogleAuth({
  credentials: config.serviceAccount,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });

export const HEADERS = [
  "Captured At",
  "Added By",
  "Source",
  "Full Name",
  "Job Title",
  "Company",
  "Email",
  "Phone",
  "Website",
  "Person LinkedIn",
  "Company LinkedIn",
  "Industry",
  "Company Size",
  "HQ / Location",
  "Company Summary",
  "Person Summary",
  "Event / Where Met",
  "Team Notes",
  "Priority",
  "Priority Reason",
  "Suggested Next Step",
  "Enrichment Confidence",
  "Sources",
  "Status",
] as const;
type Header = (typeof HEADERS)[number];
export type LeadRow = Partial<Record<Header, string>>;

const lastCol = String.fromCharCode("A".charCodeAt(0) + HEADERS.length - 1);
const range = (r: string) => `'${config.sheetTab}'!${r}`;
let tabGid = 0;

/** Creates the tab and header row if they don't exist yet. */
export async function ensureSheet(): Promise<void> {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: config.sheetId });
  const tab = meta.data.sheets?.find((s) => s.properties?.title === config.sheetTab);
  if (tab) {
    tabGid = tab.properties?.sheetId ?? 0;
  } else {
    const created = await sheets.spreadsheets.batchUpdate({
      spreadsheetId: config.sheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: config.sheetTab } } }] },
    });
    tabGid = created.data.replies?.[0]?.addSheet?.properties?.sheetId ?? 0;
  }
  const head = await sheets.spreadsheets.values.get({ spreadsheetId: config.sheetId, range: range("1:1") });
  if (!head.data.values?.[0]?.length) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: config.sheetId,
      range: range("A1"),
      valueInputOption: "RAW",
      requestBody: { values: [[...HEADERS]] },
    });
  }
}

const digits = (s: string) => s.replace(/\D/g, "");

/** Returns the 1-based row number of an existing lead with the same email or phone, if any. */
export async function findDuplicate(emails: string[], phones: string[]): Promise<number | null> {
  const emailCol = HEADERS.indexOf("Email");
  const phoneCol = HEADERS.indexOf("Phone");
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: config.sheetId,
    range: range(`A2:${lastCol}`),
  });
  const wantEmails = new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean));
  // Compare on the last 9 digits so "+92 300..." and "0300..." match.
  const wantPhones = new Set(phones.map((p) => digits(p).slice(-9)).filter((p) => p.length >= 7));

  const rows = res.data.values ?? [];
  for (let i = 0; i < rows.length; i++) {
    const rowEmails = String(rows[i][emailCol] ?? "").toLowerCase().split(/[,\s]+/);
    const rowPhones = String(rows[i][phoneCol] ?? "").split(",").map((p) => digits(p).slice(-9));
    if (rowEmails.some((e) => wantEmails.has(e)) || rowPhones.some((p) => wantPhones.has(p))) {
      return i + 2;
    }
  }
  return null;
}

export async function appendLead(row: LeadRow): Promise<number | null> {
  const res = await sheets.spreadsheets.values.append({
    spreadsheetId: config.sheetId,
    range: range("A1"),
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [HEADERS.map((h) => sanitize(row[h]))] },
  });
  const updated = res.data.updates?.updatedRange; // e.g. 'Leads'!A42:X42
  const match = updated?.match(/!A(\d+)/);
  return match ? Number(match[1]) : null;
}

/** Appends a note to the Team Notes cell of an existing row (used for duplicates). */
export async function appendNoteToRow(rowNumber: number, note: string): Promise<void> {
  const col = String.fromCharCode("A".charCodeAt(0) + HEADERS.indexOf("Team Notes"));
  const cell = range(`${col}${rowNumber}`);
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: config.sheetId, range: cell });
  const existing = res.data.values?.[0]?.[0] ?? "";
  await sheets.spreadsheets.values.update({
    spreadsheetId: config.sheetId,
    range: cell,
    valueInputOption: "RAW",
    requestBody: { values: [[existing ? `${existing}\n${note}` : note]] },
  });
}

export function rowLink(rowNumber: number | null): string {
  const base = `https://docs.google.com/spreadsheets/d/${config.sheetId}/edit`;
  return rowNumber ? `${base}#gid=${tabGid}&range=A${rowNumber}` : `${base}#gid=${tabGid}`;
}

// Prevent values like "=HYPERLINK(...)" or "+92..." from being treated as formulas.
function sanitize(value: string | undefined): string {
  if (!value) return "";
  return /^[=+\-@]/.test(value) ? `'${value}` : value;
}
