/** Shared text/formatting helpers for the harness extractors — identical logic both raw lanes need. */

/** Coerce an unknown JSONL field to a string; anything non-string becomes "". */
export function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

export const oneLine = (s: unknown): string => str(s).replace(/\s+/g, " ").trim();
export const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);
export const firstLine = (s: unknown): string => oneLine(str(s).split("\n").find((l) => l.trim()) ?? "");

export const basename = (p: unknown): string => {
  const s = str(p);
  return s.split("/").filter(Boolean).pop() ?? s;
};

/** JSON.stringify that never throws (a circular input coerces to "") — used only to scan input for secrets. */
export function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? "";
  } catch {
    return "";
  }
}
