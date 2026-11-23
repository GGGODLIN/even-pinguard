import type { ClusterState } from "../engine/types.js";

export const idleText = "Idle — no action needed";
const longDraftText = "LONG DRAFT -> OPEN PHONE";

// Leave room for pixel padding and font variance on the 576×288 lens;
// non-ASCII glyphs count double, and we never depend on breaking a long word.
const maxColumns = 32;
const maxRows = 8;

function fitsLens(text: string): boolean {
  let rows = 0;
  for (const line of text.split("\n")) {
    if (/[\p{C}\p{Zl}\p{Zp}]/u.test(line)) return false;
    rows++;
    let columns = 0;
    for (const { 0: run } of line.matchAll(/ +|[^ ]+/gu)) {
      const width = Array.from(run, (char) => char.codePointAt(0)! <= 0x7e ? 1 : 2)
        .reduce((sum, cells) => sum + cells, 0);
      if (width > maxColumns) return false;
      if (columns + width > maxColumns) {
        rows++;
        columns = 0;
      }
      columns += width;
    }
    if (rows > maxRows) return false;
  }
  return true;
}

export function formatCard(cluster?: ClusterState, armed = false): { text: string; oversized: boolean } {
  if (!cluster) return { text: idleText, oversized: false };
  if (cluster.lock_state === "AWAITING_CONFIRM" || cluster.status === "AWAITING_CONFIRM") {
    return { text: "CONFLICT HOLD\nAWAITING OPS CONFIRM", oversized: false };
  }
  if (cluster.lock_state === "HOLD_CONFLICT" || cluster.status === "HOLD_CONFLICT") {
    return { text: armed ? "CONFLICT HOLD\nSWIPE UP: ESCALATE OPS\nTAP / SWIPE DOWN: CANCEL"
      : "CONFLICT HOLD\nTAP: PREP OPS CARD", oversized: false };
  }
  if (cluster.status === "EXECUTING") return { text: idleText, oversized: false };

  const cue = armed ? "SWIPE UP: SEND + PIN" : "READY: TAP TO ARM";
  const badge = cluster.confirmed ? " [CONFIRMED]" : "";
  const text = `${cue}${badge}\n${cluster.draft}`;
  return cluster.draft.trim() && fitsLens(text) ? { text, oversized: false } : { text: longDraftText, oversized: true };
}
