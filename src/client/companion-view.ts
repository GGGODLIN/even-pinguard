import type { DeliveryReceipt, StateSnapshot } from "../engine/types.js";
import { redactSecret, sanitizeError } from "../redaction.js";

export function renderCompanionView(root: HTMLElement, state: StateSnapshot, receipts: DeliveryReceipt[]): void {
  function element<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] {
    const node = root.ownerDocument.createElement(tag);
    if (text !== undefined) node.textContent = redactSecret(text, []);
    return node;
  }

  function card(name: string, status: string, version: number, confirmed: boolean, draft: string, conflict?: string) {
    const node = element("article");
    const meta = element("p", `Version ${version}`);
    if (confirmed) meta.append(" · ", element("strong", "CONFIRMED"));
    node.append(element("h3", name), element("strong", status), meta,
      element("h4", "Canonical draft"), element("p", draft));
    if (conflict !== undefined) node.append(element("h4", "Conflicting admin text"), element("p", conflict));
    return node;
  }

  const current = element("section");
  current.append(element("h2", "Current state"));
  if (!state.clusters.length) current.append(element("p", "IDLE — no active cluster"));
  const facts = new Map(state.facts.map((fact) => [fact.fact_key, fact]));
  const activeFacts = new Set<string>();
  for (const cluster of state.clusters) {
    activeFacts.add(cluster.fact_key);
    current.append(card(cluster.fact_key, cluster.status, cluster.version, cluster.confirmed,
      cluster.draft, facts.get(cluster.fact_key)?.conflict?.text));
  }
  for (const fact of state.facts) {
    if (!activeFacts.has(fact.fact_key)) {
      current.append(card(fact.fact_key, fact.lock_state, fact.version, fact.confirmed, fact.text, fact.conflict?.text));
    }
  }

  const deliveries = element("section");
  deliveries.append(element("h2", "Delivery receipts"));
  if (!receipts.length) deliveries.append(element("p", "No public deliveries recorded."));
  for (const receipt of receipts) {
    const row = element("article");
    const fields = element("dl");
    for (const [label, value] of [
      ["chat_id", receipt.chat_id], ["message_id", String(receipt.message_id ?? "—")],
      ["sent", String(receipt.sent)], ["pinned", String(receipt.pinned)], ["status", receipt.status],
      ["error", receipt.error === null ? "—" : sanitizeError(receipt.error, [])],
    ]) {
      fields.append(element("dt", label), element("dd", value));
    }
    row.append(fields);
    deliveries.append(row);
  }

  root.replaceChildren(current, deliveries);
}
