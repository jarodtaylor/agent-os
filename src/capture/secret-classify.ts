/**
 * Capture-time secret classification (KTD2) — the ONE shared pattern set that forces a captured breadcrumb's
 * content to `secret` when it smells like a credential, so the redaction pass masks it at the default
 * threshold. Extracted from the Claude Code extractor (U5) and shared with the Codex extractor (U8): BOTH raw
 * lanes capture prompts + tool I/O VERBATIM, so a MISSED secret in either would land in a `personal`-floor
 * summary that default-threshold redaction never masks. One classifier, one place to harden.
 *
 * Non-obvious shapes (expanded per the U5 security review):
 *  - The keyword-assignment rule uses an IDENTIFIER boundary (`[^A-Za-z0-9]` + `[A-Za-z0-9_]{0,64}`), NOT `\b`:
 *    `_` is a regex word char, so a `\b`-gated `password` can't match inside `DATABASE_PASSWORD=` — the
 *    dominant real-world shape. The identifier form catches prefixed/suffixed names (`STRIPE_SECRET_KEY=`).
 *    The prefix/suffix runs are BOUNDED (`{0,64}`, not `*`): real secret-key identifiers are far shorter, and
 *    unbounded greedy runs made this pattern O(n^2) on keyword-dense input — a ReDoS-class stall once a caller
 *    (U10's blueprint front-gate) runs it over whole files up to the 16 MiB read cap.
 *  - The `sk-…` rule allows INTERNAL dashes (`sk-proj-…`, `sk-ant-api03-…`, `sk-svcacct-…`) — a bare
 *    `sk-[alnum]` form missed real dashed provider keys. It requires the body to start alphanumeric and run
 *    16+ chars, so a stray "sk-" in prose won't match; a coincidental long "sk-…" hit is over-classification.
 *  - The PEM / JWT / conn-string / Authorization rules are top-level alternatives NOT gated by `\b` (`\b`
 *    can't match before a leading `-` or `:`).
 * RESIDUAL (open-findings): regex classification cannot catch keyword-less, prefix-less high-entropy secrets
 * (a raw 40-char AWS secret, an opaque base64 blob). Over-classification is the intended KTD2 fail-safe
 * direction; the durable mitigation for any NON-local consumer is to read at `threshold:personal` (which
 * masks EVERY personal summary) rather than trust this classifier.
 */
import type { Sensitivity } from "../contract/index";

const SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9][A-Za-z0-9-]{15,}/, // OpenAI/Anthropic keys incl. DASHED variants (sk-proj-…, sk-ant-…, sk-svcacct-…)
  /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/, // Stripe secret / restricted key (underscore form)
  /\b(?:gh[posur]|github_pat)_[A-Za-z0-9_]{20,}/, // GitHub tokens (ghp_/gho_/ghu_/ghs_/ghr_/github_pat_)
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id (the secret half has no fixed prefix — see RESIDUAL)
  /\bAIza[0-9A-Za-z_-]{35}\b/, // Google API key
  /\bxox[baprsce]-[A-Za-z0-9-]{10,}/, // Slack token
  /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/, // JWT (base64url header.payload.signature)
  /:\/\/[^\s:@\/]+:[^\s@\/]+@/, // connection string with inline credentials (scheme://user:pass@host)
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/, // PEM private-key header
  /\bAuthorization:\s*(?:Bearer|Basic)\s+[A-Za-z0-9._~+\/=-]+/i, // HTTP Authorization header
  /(?:^|[^A-Za-z0-9])[A-Za-z0-9_]{0,64}(?:api[_-]?key|secret|token|password|passwd|pwd|credential)[A-Za-z0-9_]{0,64}\s*[:=]/i, // key=value / prefixed-identifier secret assignment. The {0,64} bounds (not `*`) cap the identifier prefix/suffix — real secret keys run well under 64 chars, and unbounded greedy runs made this pattern O(n^2) on keyword-dense input (a ReDoS-class stall when run over large files, e.g. U10's blueprint gate).
];

/** `secret` if any secret pattern matches `text`, else the caller's `floor`. */
export function classify(text: string, floor: Sensitivity): Sensitivity {
  return SECRET_PATTERNS.some((re) => re.test(text)) ? "secret" : floor;
}
