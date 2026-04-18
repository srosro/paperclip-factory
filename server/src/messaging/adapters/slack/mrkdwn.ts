/**
 * GitHub-flavored markdown ↔ Slack mrkdwn translation.
 *
 * Scope (Phase 1): covers the common shapes agent comments use. Tables drop
 * to plaintext with `|` separators; fenced code blocks keep fences but drop
 * the language label (Slack mrkdwn ignores it); links flip between the two
 * syntaxes; bullet lists map `-`/`*` ↔ `•`.
 */
const BOLD_SENTINEL_OPEN = "\u0001BOLD_OPEN\u0001";
const BOLD_SENTINEL_CLOSE = "\u0001BOLD_CLOSE\u0001";

export function fromGfm(gfm: string): string {
  let out = gfm;
  // Fenced code: preserve body, drop language tag so Slack keeps monospace.
  out = out.replace(/```(\w+)?\n([\s\S]*?)```/g, (_m, _lang, body) => "```\n" + body + "```");
  // Bold: **x** → placeholder so subsequent italic handling doesn't collapse it.
  out = out.replace(
    /\*\*(.+?)\*\*/g,
    (_m, inner) => `${BOLD_SENTINEL_OPEN}${inner}${BOLD_SENTINEL_CLOSE}`,
  );
  // Italic: single * or _ → _x_ (Slack's italic marker).
  out = out.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "_$1_");
  // Restore bold as Slack's single-asterisk form.
  out = out
    .replace(new RegExp(BOLD_SENTINEL_OPEN, "g"), "*")
    .replace(new RegExp(BOLD_SENTINEL_CLOSE, "g"), "*");
  // Links: [text](url) → <url|text>
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<$2|$1>");
  // Task lists
  out = out.replace(/^([ \t]*)- \[ \] /gm, "$1☐ ");
  out = out.replace(/^([ \t]*)- \[x\] /gim, "$1☑ ");
  // Unordered list bullets → •
  out = out.replace(/^([ \t]*)[*-] (?!\[)/gm, "$1• ");
  return out;
}

export function toGfm(mrkdwn: string): string {
  let out = mrkdwn;
  // Links: <url|text> → [text](url); bare <url> → url (preserved as-is).
  out = out.replace(/<([^|>]+)\|([^>]+)>/g, "[$2]($1)");
  out = out.replace(/<(https?:[^>]+)>/g, "$1");
  // Bold: *x* → **x** (but not italic _x_ which we leave alone for GFM).
  out = out.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "**$1**");
  // Bullets: • → -
  out = out.replace(/^([ \t]*)• /gm, "$1- ");
  // Task list glyphs back to GFM form
  out = out.replace(/^([ \t]*)☐ /gm, "$1- [ ] ");
  out = out.replace(/^([ \t]*)☑ /gm, "$1- [x] ");
  return out;
}
