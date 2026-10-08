import { google } from "googleapis";
import { config } from "./config.js";

function client() {
  if (!config.features.leadCrm || !config.sheetId || !config.serviceAccount) {
    throw new Error("Lead CRM Google Sheets backend is not configured");
  }
  const auth = new google.auth.GoogleAuth({
    credentials: config.serviceAccount,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return google.sheets({ version: "v4", auth });
}

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
  "Owner",
  "Follow-up Due",
  "Last Activity",
  "Pipeline Stage",
  "Activity Timeline",
] as const;
type Header = (typeof HEADERS)[number];
export type LeadRow = Partial<Record<Header, string>>;

const lastCol = String.fromCharCode("A".charCodeAt(0) + HEADERS.length - 1);
const range = (r: string) => `'${config.sheetTab}'!${r}`;
let tabGid = 0;

/** Creates the tab and header row if they don't exist yet. */
export async function ensureSheet(): Promise<void> {
  const meta = await client().spreadsheets.get({ spreadsheetId: config.sheetId });
  const tab = meta.data.sheets?.find((s) => s.properties?.title === config.sheetTab);
  if (tab) {
    tabGid = tab.properties?.sheetId ?? 0;
  } else {
    const created = await client().spreadsheets.batchUpdate({
      spreadsheetId: config.sheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: config.sheetTab } } }] },
    });
    tabGid = created.data.replies?.[0]?.addSheet?.properties?.sheetId ?? 0;
  }
  const head = await client().spreadsheets.values.get({ spreadsheetId: config.sheetId, range: range("1:1") });
  const existingHeaders = (head.data.values?.[0] ?? []).map(String);
  if (!existingHeaders.length) {
    await client().spreadsheets.values.update({
      spreadsheetId: config.sheetId,
      range: range("A1"),
      valueInputOption: "RAW",
      requestBody: { values: [[...HEADERS]] },
    });
  } else {
    const missing = HEADERS.filter((header) => !existingHeaders.includes(header));
    if (missing.length) {
      const startCol = columnName(existingHeaders.length + 1);
      await client().spreadsheets.values.update({
        spreadsheetId: config.sheetId,
        range: range(`${startCol}1`),
        valueInputOption: "RAW",
        requestBody: { values: [[...missing]] },
      });
    }
  }
}

function columnName(index: number): string {
  let n = index;
  let out = "";
  while (n > 0) {
    n--;
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26);
  }
  return out;
}

const digits = (s: string) => s.replace(/\D/g, "");

/** Returns the 1-based row number of an existing lead with the same email or phone, if any. */
export async function findDuplicate(emails: string[], phones: string[]): Promise<number | null> {
  const emailCol = HEADERS.indexOf("Email");
  const phoneCol = HEADERS.indexOf("Phone");
  const res = await client().spreadsheets.values.get({
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
  const res = await client().spreadsheets.values.append({
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
  const res = await client().spreadsheets.values.get({ spreadsheetId: config.sheetId, range: cell });
  const existing = res.data.values?.[0]?.[0] ?? "";
  await client().spreadsheets.values.update({
    spreadsheetId: config.sheetId,
    range: cell,
    valueInputOption: "RAW",
    requestBody: { values: [[existing ? `${existing}\n${note}` : note]] },
  });
}

export function rowLink(rowNumber: number | null): string {
  if (!config.sheetId) return "";
  const base = `https://docs.google.com/spreadsheets/d/${config.sheetId}/edit`;
  return rowNumber ? `${base}#gid=${tabGid}&range=A${rowNumber}` : `${base}#gid=${tabGid}`;
}

// Prevent values like "=HYPERLINK(...)" or "+92..." from being treated as formulas.
function sanitize(value: string | undefined): string {
  if (!value) return "";
  return /^[=+\-@]/.test(value) ? `'${value}` : value;
}


async function readLeadRows(): Promise<string[][]> {
  const res = await client().spreadsheets.values.get({
    spreadsheetId: config.sheetId,
    range: range(`A2:${lastCol}`),
  });
  return (res.data.values ?? []) as string[][];
}

function rowObject(row: string[]): LeadRow {
  const out: LeadRow = {};
  HEADERS.forEach((header, i) => {
    out[header] = String(row[i] ?? "");
  });
  return out;
}

export async function searchLeads(query: string, limit = 50): Promise<LeadRow[]> {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const rows = await readLeadRows();
  const matches: LeadRow[] = [];
  for (const row of rows) {
    if (row.some((value) => String(value ?? "").toLowerCase().includes(needle))) {
      matches.push(rowObject(row));
      if (matches.length >= Math.max(1, Math.min(limit, 100))) break;
    }
  }
  return matches;
}

export async function leadSummary(): Promise<{ total: number; hot: number; warm: number; cold: number; new: number }> {
  const rows = await readLeadRows();
  const priorityCol = HEADERS.indexOf("Priority");
  const statusCol = HEADERS.indexOf("Status");
  let hot = 0, warm = 0, cold = 0, fresh = 0;
  for (const row of rows) {
    const priority = String(row[priorityCol] ?? "").toLowerCase();
    const status = String(row[statusCol] ?? "").toLowerCase();
    if (priority === "hot") hot++;
    else if (priority === "warm") warm++;
    else if (priority === "cold") cold++;
    if (status === "new") fresh++;
  }
  return { total: rows.length, hot, warm, cold, new: fresh };
}


export async function updateLeadFields(rowNumber: number, fields: LeadRow): Promise<void> {
  if (!Number.isInteger(rowNumber) || rowNumber < 2) throw new Error("Invalid CRM row");
  const now = new Date().toISOString();
  const updates: { range: string; values: string[][] }[] = [];
  for (const [key, value] of Object.entries(fields)) {
    const index = HEADERS.indexOf(key as Header);
    if (index < 0) continue;
    updates.push({
      range: range(`${columnName(index + 1)}${rowNumber}`),
      values: [[sanitize(String(value ?? ""))]],
    });
  }
  const activityIndex = HEADERS.indexOf("Last Activity");
  if (activityIndex >= 0 && fields["Last Activity"] == null) {
    updates.push({
      range: range(`${columnName(activityIndex + 1)}${rowNumber}`),
      values: [[now]],
    });
  }
  if (!updates.length) return;
  await client().spreadsheets.values.batchUpdate({
    spreadsheetId: config.sheetId!,
    requestBody: { valueInputOption: "RAW", data: updates },
  });
}

export async function appendActivity(rowNumber: number, text: string): Promise<void> {
  const index = HEADERS.indexOf("Activity Timeline");
  if (index < 0) return;
  const cell = range(`${columnName(index + 1)}${rowNumber}`);
  const res = await client().spreadsheets.values.get({ spreadsheetId: config.sheetId!, range: cell });
  const existing = String(res.data.values?.[0]?.[0] ?? "");
  const line = `[${new Date().toISOString()}] ${text}`;
  await client().spreadsheets.values.update({
    spreadsheetId: config.sheetId!,
    range: cell,
    valueInputOption: "RAW",
    requestBody: { values: [[existing ? `${existing}\n${line}` : line]] },
  });
  await updateLeadFields(rowNumber, { "Last Activity": new Date().toISOString() });
}

export async function pipelineSummary(): Promise<Record<string, number>> {
  const rows = await readLeadRows();
  const index = HEADERS.indexOf("Pipeline Stage");
  const counts: Record<string, number> = {};
  for (const row of rows) {
    const stage = String(row[index] ?? "New").trim() || "New";
    counts[stage] = (counts[stage] ?? 0) + 1;
  }
  return counts;
}
