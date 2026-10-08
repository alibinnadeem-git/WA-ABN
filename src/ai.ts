import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { config } from "./config.js";

const client = new Anthropic();

// Server-side fallback: if a request is declined by a safety classifier, the API
// re-runs it on Anthropic's recommended fallback model instead of returning a refusal.
const FALLBACK: Pick<Anthropic.Beta.MessageCreateParamsNonStreaming, "betas" | "fallbacks"> = {
  betas: ["server-side-fallback-2026-07-01"],
  fallbacks: "default",
};

// ---------- Step 1: read the message (card photo / shared contact / typed text) ----------

const LeadSchema = z.object({
  full_name: z.string().nullable(),
  job_title: z.string().nullable(),
  company: z.string().nullable(),
  emails: z.array(z.string()),
  phones: z.array(z.string()).describe("E.164 format where possible, e.g. +14155550123"),
  website: z.string().nullable(),
  linkedin: z.string().nullable(),
  address: z.string().nullable(),
  other_details: z.string().nullable().describe("Anything else printed on the card: social handles, tagline, services"),
});
export type Lead = z.infer<typeof LeadSchema>;

const ExtractionSchema = z.object({
  is_lead: z
    .boolean()
    .describe("True only if the message contains at least one person or business to save as a lead"),
  leads: z.array(LeadSchema),
  context_from_message: z
    .string()
    .nullable()
    .describe(
      "Team notes already given in the caption/text: where they met, what the lead wants, priority, follow-up owner. Null if none.",
    ),
  event_from_message: z.string().nullable().describe("Event or place where they met, if stated"),
  image_notes: z
    .string()
    .nullable()
    .describe("Useful visual observations, e.g. handwritten notes on the card, booth signage, badge text"),
});
export type Extraction = z.infer<typeof ExtractionSchema>;

export interface MessageInput {
  images: { data: Buffer; mediaType: "image/jpeg" | "image/png" | "image/webp" | "image/gif" }[];
  vcards: string[];
  text: string | null;
}

const EXTRACT_SYSTEM = `You are the lead-capture assistant for ${config.appName}. Team members post leads they met at events or in person: photos of business cards (front/back, possibly several cards in one photo), shared WhatsApp contacts (vCards), or typed names/numbers, often with a short caption.

Extract every distinct lead exactly as printed — do not invent or guess values that are not visible or stated. Read handwriting on cards too. Normalise phone numbers to E.164${config.defaultRegion ? `, assuming country ${config.defaultRegion} when no country code is shown` : ""}. If a field is not present, use null (or an empty list).

Group chatter that is not a lead (greetings, questions, jokes, logistics) → is_lead=false and leads=[].`;

export async function extractLeads(input: MessageInput): Promise<Extraction> {
  const content: Anthropic.Beta.BetaContentBlockParam[] = [];
  for (const img of input.images) {
    content.push({
      type: "image",
      source: { type: "base64", media_type: img.mediaType, data: img.data.toString("base64") },
    });
  }
  for (const vcard of input.vcards) {
    content.push({ type: "text", text: `Shared contact (vCard):\n${vcard}` });
  }
  content.push({
    type: "text",
    text: input.text ? `Message text / caption:\n${input.text}` : "(no caption)",
  });

  const response = await client.beta.messages.parse({
    model: config.model,
    max_tokens: 8000,
    ...FALLBACK,
    thinking: { type: "adaptive" },
    output_config: { effort: "medium", format: betaZodOutputFormat(ExtractionSchema) },
    system: EXTRACT_SYSTEM,
    messages: [{ role: "user", content }],
  });

  if (response.stop_reason === "refusal" || !response.parsed_output) {
    throw new Error(`Extraction failed (stop_reason=${response.stop_reason})`);
  }
  return response.parsed_output;
}

// ---------- Step 2: enrich a lead with web research ----------

const EnrichmentSchema = z.object({
  full_name: z.string().nullable(),
  job_title: z.string().nullable(),
  company: z.string().nullable(),
  company_website: z.string().nullable(),
  person_linkedin: z.string().nullable(),
  company_linkedin: z.string().nullable(),
  industry: z.string().nullable(),
  company_size: z.string().nullable().describe("Employee range, e.g. '51-200'"),
  hq_location: z.string().nullable(),
  company_summary: z.string().nullable().describe("1-2 sentences on what the company does"),
  person_summary: z.string().nullable().describe("1-2 sentences on the person's role/background"),
  priority: z.enum(["Hot", "Warm", "Cold"]).describe(`Fit for ${config.appName}, using the configured application/business context`),
  priority_reason: z.string(),
  suggested_next_step: z.string(),
  confidence: z.enum(["High", "Medium", "Low"]).describe("How sure you are the web results are the same person/company"),
  sources: z.array(z.string()).describe("URLs used"),
});
export type Enrichment = z.infer<typeof EnrichmentSchema>;

export async function enrichLead(lead: Lead, teamContext: string | null, event: string | null): Promise<Enrichment> {
  const system = `You enrich sales leads for STRATUM.

About STRATUM and who we sell to:
${config.companyContext}

Research the lead on the web: confirm the company, its website, industry, size and HQ, and find the person's LinkedIn profile and role. Prefer official sites and LinkedIn. Be careful with common names — only attribute a profile to the lead when the company or other details match; otherwise leave it null and lower the confidence. Keep values from the card unless the web clearly corrects a typo. Keep searches focused (a handful is enough).`;

  const user = `Lead captured by the team:
${JSON.stringify(lead, null, 2)}

Where we met: ${event ?? "unknown"}
Team notes: ${teamContext ?? "none"}`;

  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: user }];
  const tools: Anthropic.Beta.BetaToolUnion[] = [
    { type: "web_search_20260209", name: "web_search", max_uses: 6 },
    { type: "web_fetch_20260209", name: "web_fetch", max_uses: 4 },
  ];

  // Server-tool loops can pause after many iterations; resume a few times if so.
  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await client.beta.messages.parse({
      model: config.model,
      max_tokens: 16000,
      ...FALLBACK,
      thinking: { type: "adaptive" },
      output_config: { effort: "medium", format: betaZodOutputFormat(EnrichmentSchema) },
      system,
      tools,
      messages,
    });

    if (response.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: response.content });
      continue;
    }
    if (response.stop_reason === "refusal" || !response.parsed_output) {
      throw new Error(`Enrichment failed (stop_reason=${response.stop_reason})`);
    }
    return response.parsed_output;
  }
  throw new Error("Enrichment did not finish after several continuations");
}
