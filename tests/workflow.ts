// Reading workflow files in tests: line endings are normalized, so a CRLF checkout (core.autocrlf=true on
// Windows) reads the same as CI's LF one (REVIEW-2 #6).
import fs from 'node:fs';

export const normalizeEol = (s: string) => s.replace(/\r\n?/g, '\n');

/** `.github/workflows/<name>` with LF line endings. */
export const readWorkflow = (name: string) => normalizeEol(fs.readFileSync(`.github/workflows/${name}`, 'utf8'));

/** The same without comments (what actually runs). */
export const workflowCode = (name: string) => readWorkflow(name).replace(/#.*$/gm, '');
