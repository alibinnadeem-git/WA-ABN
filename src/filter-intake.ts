import { extractLeads, type MessageInput } from "./ai.js";
import { config } from "./config.js";
import { stageFilterLead, filterSourceRegistry } from "./filter-runtime.js";

/** Optional AI intake ONLY for explicit captures, images and vCards. */
export async function handleFilterOnlyIntake(
  input: MessageInput,
  sourceMessageId: string,
  groupJid: string,
  senderJid: string,
  reply: (message: string) => Promise<void>,
): Promise<void> {
  if (!config.features.filterCrm) return;
  const explicitText = input.text?.trim().startsWith("!capture ");
  if (!explicitText && input.images.length === 0 && input.vcards.length === 0) return;
  if (!config.features.aiExtraction) {
    await reply("Filter CRM recorded this source, but AI card/contact extraction is disabled. Capture a lead with !lead Name | Company | Email | Phone | Notes.");
    return;
  }
  const requested: MessageInput = explicitText
    ? { ...input, text: input.text!.trim().slice("!capture ".length) }
    : input;
  let extraction;
  try {
    extraction = await extractLeads(requested);
  } catch (error) {
    console.error("Filter CRM extraction failed", error instanceof Error ? error.name : "unknown");
    await reply("Filter CRM received the source but could not extract a lead. Please use !lead or request manual review.");
    return;
  }
  if (!extraction.is_lead || !extraction.leads.length) {
    await reply("Filter CRM: no contact was extracted. Please use !lead Name | Company | Email | Phone | Notes.");
    return;
  }
  const outputs: string[] = [];
  for (const [index, item] of extraction.leads.entries()) {
    const staged = stageFilterLead({
      name: item.full_name || item.emails[0] || item.phones[0] || "Unidentified contact",
      company: item.company || "",
      email: item.emails[0] || "",
      phone: item.phones[0] || "",
      notes: [extraction.context_from_message, item.other_details].filter(Boolean).join("\n"),
      sourceMessageId: sourceMessageId + ":" + index,
      sourceGroupJid: groupJid,
      sourceSenderJid: senderJid,
    }, "Filter CRM AI intake");
    if (staged) outputs.push(
      `${staged.lead.name} → ${staged.disposition} · Filter ID ${staged.id} · awaiting reviewer action`
    );
  }
  await reply("Filter CRM staged (nothing sent to STRATUM CRM):\n" + outputs.join("\n"));
}
