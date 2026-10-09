/** Structured, provider-free lead capture for vendor CRM workflows. */
export interface ManualLead {
  name: string;
  company: string;
  email: string;
  phone: string;
  notes: string;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_CHARACTERS = /^[+0-9 ()-]+$/;

export function parseManualLead(raw: string): ManualLead {
  const fields = raw.split("|").map((value) => value.trim());
  if (fields.length !== 5) {
    throw new Error("Expected 5 fields: Full Name | Company | Email | Phone | Notes (leave a field blank if unknown)");
  }
  const [name, company, email, phone, notes] = fields;
  if (!name || name.length > 160 || !company || company.length > 160) {
    throw new Error("Name and company are required (up to 160 characters each)");
  }
  if (email.length > 254 || (email && !EMAIL.test(email))) {
    throw new Error("Invalid email address");
  }
  const digits = phone.replace(/\D/g, "");
  if (phone.length > 40 || (phone && (!PHONE_CHARACTERS.test(phone) || digits.length < 7 || digits.length > 15))) {
    throw new Error("Invalid telephone number");
  }
  if (!email && !phone) {
    throw new Error("Either email or phone is required for duplicate detection");
  }
  if (notes.length > 1000) {
    throw new Error("Notes may not exceed 1,000 characters");
  }
  return { name, company, email: email.toLowerCase(), phone, notes };
}
