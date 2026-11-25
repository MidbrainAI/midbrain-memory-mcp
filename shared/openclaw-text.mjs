/**
 * The text a person typed in an OpenClaw user message (#117), shared by the
 * live capture plugin (plugins/openclaw) and the history importer.
 *
 * OpenClaw adds two things to what the user sent:
 * - an inbound envelope with the time: "[Mon 2026-10-05 09:00 GMT+2] text";
 * - runtime context between <<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>> and
 *   <<<END_OPENCLAW_INTERNAL_CONTEXT>>> lines, which OpenClaw itself marks
 *   "runtime context for the user request they follow, not user-authored
 *   text". It can sit inside the prompt or be a user message of its own.
 */

// OpenClaw's inbound envelope: "[Mon 2026-10-05 09:00 ...] text".
const TIMESTAMP_ENVELOPE = /^\[[^\]\n]*\d{4}-\d{2}-\d{2} \d{2}:\d{2}[^\]\n]*\]\s*/;

// A delimited block: each delimiter on its own line, as OpenClaw writes it. A
// block with no end line runs to the end of the text, and an end line left
// over is removed, as OpenClaw strips them. Not handled (OpenClaw does not
// write them today): nested blocks, and the legacy "OpenClaw runtime context
// (internal):" format.
const INTERNAL_CONTEXT_BLOCK =
  /(?:^|\r?\n)[ \t]*<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>[ \t]*(?:\r?\n(?:[\s\S]*?\r?\n)?[ \t]*<<<END_OPENCLAW_INTERNAL_CONTEXT>>>[ \t]*(?=\r?\n|$)|(?:\r?\n[\s\S]*)?$)/g;
const LEFTOVER_END = /(?:^|\r?\n)[ \t]*<<<END_OPENCLAW_INTERNAL_CONTEXT>>>[ \t]*(?=\r?\n|$)/g;

/** The typed text of an OpenClaw user message: no runtime context, no envelope. */
export function openclawTypedText(text) {
  return text.replace(INTERNAL_CONTEXT_BLOCK, "").replace(LEFTOVER_END, "").trim()
    .replace(TIMESTAMP_ENVELOPE, "").trim();
}
