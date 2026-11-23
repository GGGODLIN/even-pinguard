import { casual, zh, type Component, type ParsedComponents } from "chrono-node";
import MiniSearch from "minisearch";

const stopWords = new Set([
  "a", "an", "any", "are", "at", "be", "can", "do", "does", "for", "how", "i", "in", "is", "it",
  "me", "of", "on", "or", "please", "s", "the", "to", "we", "what", "when", "where", "which", "who",
  "will", "with", "you",
]);

function tokenize(text: string): string[] {
  const runs = text.normalize("NFKC").toLowerCase().match(
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+|[a-z]+/gu,
  ) ?? [];
  return runs.flatMap((run) => {
    if (/^[a-z]+$/.test(run)) return stopWords.has(run) ? [] : [run];
    const letters = Array.from(run);
    return letters.length === 1 ? letters : letters.slice(1).map((letter, index) => letters[index] + letter);
  });
}

interface SearchableFact {
  factKey: string;
  text: string;
  questions: readonly string[];
}

export function matchFact(text: string, facts: readonly SearchableFact[]): { factKey: string; questionMatches: boolean } | undefined {
  const index = new MiniSearch<{ factKey: string; topic: string; text: string }>({
    idField: "factKey",
    fields: ["topic", "text"],
    tokenize,
    searchOptions: { boost: { topic: 2 } },
  });
  index.addAll(facts.map((fact) => ({
    factKey: fact.factKey,
    topic: [fact.factKey, ...fact.questions].join(" "),
    text: fact.text,
  })));
  const [best, next] = index.search(text);
  if (!best || best.score <= (next?.score ?? 0)) return undefined;
  // A generic shared word such as "deadline" should not cluster an unrelated question.
  const matched = new Set(best.queryTerms).size;
  const total = new Set(tokenize(text)).size;
  const questionMatches = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(text)
    ? matched >= Math.min(2, total)
    : matched * 2 > total;
  return { factKey: String(best.id), questionMatches };
}

export function isQuestion(text: string): boolean {
  return /[?？]|請問|何時|哪[天裡里個个]|什[麼么]時候|多少|幾[點時号號]/u.test(text) ||
    /^(?:anyone|can|could|do|does|how|is|are|what|when|where|which|who|will|would)\b/i.test(text);
}

interface Values {
  dates: ParsedComponents[];
  numbers: { kind: string; value: number }[];
}

function extractValues(text: string, timestamp: number): Values {
  const normalized = text.normalize("NFKC");
  const reference = { instant: new Date(timestamp * 1_000), timezone: 0 };
  const candidates = casual.parse(normalized, reference);
  if (/\p{Script=Han}/u.test(normalized)) candidates.push(...zh.casual.parse(normalized, reference));
  candidates.sort((left, right) => left.index - right.index || right.text.length - left.text.length);

  const dates: ParsedComponents[] = [];
  let remainder = "";
  let end = 0;
  for (const result of candidates) {
    if (result.index < end) continue;
    remainder += `${normalized.slice(end, result.index)} `;
    end = result.index + result.text.length;
    for (const parts of result.end ? [result.start, result.end] : [result.start]) {
      if (parts.isCertain("day") || parts.isCertain("weekday")) dates.push(parts);
    }
  }
  remainder += normalized.slice(end);
  const numbers = Array.from(remainder.matchAll(
    /(?<![a-z0-9])(?:(NT\$|US\$|USD\s*|TWD\s*|[$€£])\s*)?([+-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?|[+-]?\d+(?:\.\d+)?)\s*(%|USD\b|TWD\b|元|seats?\b|spots?\b|places?\b|人|位)?(?![a-z0-9])/giu,
  ), ([, prefix, number, suffix]) => ({
    kind: numericKind((prefix ?? suffix ?? "").trim().toUpperCase()),
    value: Number(number.replaceAll(",", "")),
  }));
  return { dates, numbers };
}

function numericKind(unit: string): string {
  if (["$", "US$", "USD"].includes(unit)) return "USD";
  if (["NT$", "TWD", "元"].includes(unit)) return "TWD";
  if (/^(?:SEATS?|SPOTS?|PLACES?|人|位)$/.test(unit)) return "capacity";
  return unit;
}

function componentsAgree(left: ParsedComponents, right: ParsedComponents, components: readonly Component[]): boolean {
  return components.every((part) => !left.isCertain(part) || !right.isCertain(part) || left.get(part) === right.get(part));
}

export function valuesConflict(canonical: string, effectiveAt: number, candidate: string, timestamp: number): boolean {
  const baseline = extractValues(canonical, effectiveAt);
  const incoming = extractValues(candidate, timestamp);
  if (baseline.dates.length && incoming.dates.some((date) => !baseline.dates.some((old) =>
    componentsAgree(old, date, ["year", "month", "day", "weekday"])))) return true;

  for (const kind of new Set(incoming.numbers.map((number) => number.kind))) {
    const incomingForKind = incoming.numbers.filter((number) => number.kind === kind);
    const baselineForKind = baseline.numbers.filter((number) => number.kind === kind);
    if (incomingForKind.length > 1 && incomingForKind.length === baselineForKind.length &&
        incomingForKind.some((number, index) => number.value !== baselineForKind[index].value)) return true;
  }

  return incoming.numbers.some((number) => {
    const comparable = baseline.numbers.filter((old) => old.kind === number.kind ||
      (baseline.numbers.length === 1 && incoming.numbers.length === 1 && (!old.kind || !number.kind)));
    return comparable.length > 0 && comparable.every((old) => old.value !== number.value);
  });
}
