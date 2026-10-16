// Native side of the footprint sample (see heavy-tabs.ts for why the footprint and
// not the working set): one `top -l 1` run, parsed into pid → bytes. Async so the
// main process never blocks on it. No Electron here.

import { execFile } from 'node:child_process'
import { parseTopMemory } from './heavy-tabs'

/** Physical footprint of every process on the machine, keyed by pid. Resolves to
 * an empty map when `top` fails, so a caller falls back to the working set. */
export function sampleFootprint(): Promise<Map<number, number>> {
  return new Promise((resolve) => {
    execFile(
      '/usr/bin/top',
      ['-l', '1', '-stats', 'pid,mem'],
      { maxBuffer: 8 * 1024 * 1024, timeout: 15_000 },
      (error, stdout) => resolve(error ? new Map() : parseTopMemory(stdout))
    )
  })
}
