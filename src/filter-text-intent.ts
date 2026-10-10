import type { FilterLeadInput } from "./filter-classifier.js";

/** High-precision passive lead cues. Ordinary chat is ignored. Never invents a person or employer. */
const CONTEXT_CUE = /\b(?:lead|prospect|met|contact|referral|referred|business card|potential client|sales opportunity|procurement contact)\b/i;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const PHONE = /(?:\+?\d[\d ()-]{8,}\d)/;
const NAME = /\b(?:name|contact|lead|prospect|met)\s*(?::|=|is)?\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})(?=[,;\n.]|\s+(?:at|from|with|of|yesterday|today|recently)\b|$)/i;
const COMPANY = /\b(?:company|firm|employer|organization)\s*(?::|=|is)\s*([^;,\n.]{2,100})/i;

export function passiveLeadFromText(raw: string): FilterLeadInput | null {
  const text = raw.trim().slice(0,3000);
  if (!CONTEXT_CUE.test(text) || text.startsWith("!") || !text) return null;
  const email = text.match(EMAIL)?.[0].toLowerCase() ?? "";
  const phone = text.match(PHONE)?.[0].trim() ?? "";
  const name = text.match(NAME)?.[1]?.trim() ?? "Unidentified contact";
  const company = text.match(COMPANY)?.[1]?.trim() ?? "";
  // Contactless introductions still matter: stage only when BOTH named person
  // and explicitly labeled company exist, never treat casual mentions as qualified.
  if (!email && !phone && (name === "Unidentified contact" || !company)) return null;
  return { name, company, email, phone, notes: text.slice(0,2000) };
}
