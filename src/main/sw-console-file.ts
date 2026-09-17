/** On-disk mirror of the extension service-worker console: how it is
 * serialized, and when it has grown enough to be compacted back to the tail the
 * in-memory ring buffer holds. Pure logic, no fs — see extensions.ts for the
 * calls that actually touch the file. */

/** Lines the JSONL mirror may reach before it is rewritten to the in-memory
 * tail. A chatty extension (cookies.onChanged fires per cookie write) appends
 * tens of thousands of lines an hour, so without this the file only shrinks at
 * startup: one 22h run left a 250 MB mirror on disk. */
export const SW_CONSOLE_FILE_LIMIT = 20000

/** True when the mirror holds enough lines to be worth rewriting. */
export function shouldCompactSwConsole(lines: number, limit = SW_CONSOLE_FILE_LIMIT): boolean {
  return lines >= limit
}

/** JSONL body for `entries` — empty string for an empty buffer, so compacting
 * an empty ring truncates the file instead of writing a lone newline. */
export function serializeSwConsole(entries: readonly unknown[]): string {
  if (entries.length === 0) return ''
  return entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n'
}
