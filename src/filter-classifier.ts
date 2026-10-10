export type FilterDisposition = "STRATUM_RELATED" | "UNRELATED" | "NEEDS_REVIEW";
export interface FilterLeadInput {
  name: string;
  company: string;
  email: string;
  phone: string;
  notes: string;
  sourceMessageId?: string;
  capturedAt?: string;
}

/** Conservative, explainable initial STRATUM relevance rules. Not an invented fit score. */
const SIGNALS: Array<[RegExp, string]> = [
  [/\b(?:electrical (?:contracting|distribution|infrastructure|installation|construction|works)|switchgear|substation|transformer|medium[- ]voltage|high[- ]voltage)\b/i, "Electrical infrastructure"],
  [/\b(?:data center|data centre|hyperscale|critical power|ai infrastructure|power plant|backup generator|battery storage|uninterruptible power|ups system)\b/i, "Power or data-center infrastructure"],
  [/\b(?:ev charging infrastructure|charging station installation|industrial electrical|epc&c|design[- ]build electrical|electrical maintenance)\b/i, "Electrical project delivery"],
];
const DEMAND = /\b(?:need|needs|request|rfp|bid|bidding|tender|quote|quoting|proposal|project|build|install|upgrade|retrofit|commission|maintenance|contractor|contracting|procurement|develop|expansion)\b/i;
const CLEARLY_OTHER = /\b(?:cosmetic salon|nail salon|beauty parlou?r|perfume retail|hair salon|fashion boutique|makeup artist|wedding photography|cake bakery|travel agency|restaurant menu|pet grooming)\b/i;

export function classifyStratumLead(input: FilterLeadInput): {
  disposition: FilterDisposition;
  reasons: string[];
  score: number;
  classifierVersion: "stratum-rules-v1";
} {
  const text = [input.company, input.notes].filter(Boolean).join(" ").slice(0, 3500);
  const reasons = SIGNALS.filter(([regex]) => regex.test(text)).map(([, reason]) => reason);
  const hasDemand = DEMAND.test(text);
  const direct = /\bstratum (?:power|electric|electrical)\b/i.test(text);
  const other = CLEARLY_OTHER.test(text);
  if (direct && (reasons.length || hasDemand) && !other) {
    return { disposition:"STRATUM_RELATED",reasons:["STRATUM expressly referenced",...reasons],score:0.95,classifierVersion:"stratum-rules-v1" };
  }
  if ((reasons.length >= 2 || (reasons.length >= 1 && hasDemand)) && !other) {
    return { disposition:"STRATUM_RELATED",reasons:[...reasons, ...(hasDemand ? ["Explicit project or service signal"] : [])],score:0.86,classifierVersion:"stratum-rules-v1" };
  }
  if (other && !reasons.length && !direct) {
    return { disposition:"UNRELATED",reasons:["Explicitly non-STRATUM service context"],score:0.85,classifierVersion:"stratum-rules-v1" };
  }
  return { disposition:"NEEDS_REVIEW",reasons:reasons.length ? [...reasons,"Insufficient evidence of an applicable project"] : ["No defensible business-sector match"],score:0.35,classifierVersion:"stratum-rules-v1" };
}
