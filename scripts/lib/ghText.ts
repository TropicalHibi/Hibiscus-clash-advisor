// Small helpers shared by the two daily Actions' CLIs (data-update, meta-ci): issue-body Markdown and step outputs.
import fs from 'node:fs';

/** The last `n` lines, with a note about how many came before. */
export const tail = (lines: string[], n: number) => (lines.length > n ? [`… (${lines.length - n} earlier lines)`, ...lines.slice(-n)] : lines);

/** A fenced code block; a ``` inside can't close it early. */
export const fence = (lines: string[]) => ['```', ...lines.map((l) => l.replace(/```/g, "'''")), '```'];

/** Writes single-line step outputs to $GITHUB_OUTPUT (no-op outside Actions). Newlines become spaces. */
export function setOutputs(values: Record<string, string | number | boolean | undefined>, file = process.env.GITHUB_OUTPUT): void {
  if (!file) return;
  fs.appendFileSync(file, Object.entries(values).map(([k, v]) => `${k}=${String(v ?? '').replace(/\r?\n/g, ' ')}\n`).join(''));
}
