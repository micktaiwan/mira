import { describe, expect, it } from 'vitest'
import { callerFrame, classifyActivation, formatActivationEntry } from './activation-trace'

const OURS = [
  'Error',
  '    at observer (/app/out/main/mac-activation.js:40:20)',
  '    at ProfileManager.focusApp (/app/out/main/profiles.js:5440:12)',
  '    at handleCommand (/app/out/main/commands/app.js:20:5)'
].join('\n')

const TRACE_ONLY = [
  'Error',
  '    at observer (/app/out/main/mac-activation.js:40:20)',
  '    at formatActivationEntry (/app/out/main/activation-trace.js:70:3)'
].join('\n')

// A packaged build bundles everything into one index.js, so file names no longer
// tell the observer apart from its caller — only its POSITION does (always first).
const PACKAGED_OBSERVER_ONLY = [
  'Error',
  '    at /App/Contents/Resources/app.asar/out/main/index.js:6008:59',
  '    at process.processTicksAndRejections (node:internal/process/task_queues:85:11)'
].join('\n')

const PACKAGED_OURS = [
  'Error',
  '    at /App/Contents/Resources/app.asar/out/main/index.js:6008:59',
  '    at BrowserWindow.<anonymous> (/App/Contents/Resources/app.asar/out/main/index.js:12880:85)',
  '    at BrowserWindow.emit (node:events:509:28)'
].join('\n')

describe('classifyActivation', () => {
  it('reads a stack with no frames at all as Chromium', () => {
    expect(classifyActivation(undefined)).toBe('chromium')
  })

  it('reads a stack made only of the trace machinery as Chromium', () => {
    // Chromium activates from C++: the only JS on the stack is our own observer.
    expect(classifyActivation(TRACE_ONLY)).toBe('chromium')
  })

  it('reads a stack carrying app frames as our own code', () => {
    expect(classifyActivation(OURS)).toBe('app')
  })

  // Measured on the packaged app, 2026-09-12: without dropping the observer frame
  // by position, every Chromium activation reads as one of ours.
  it('drops the observer frame in a packaged build, where paths all look alike', () => {
    expect(classifyActivation(PACKAGED_OBSERVER_ONLY)).toBe('chromium')
    expect(classifyActivation(PACKAGED_OURS)).toBe('app')
    expect(callerFrame(PACKAGED_OURS)).toContain('index.js:12880')
  })
})

describe('callerFrame', () => {
  it('names the first frame outside the trace machinery', () => {
    expect(callerFrame(OURS)).toBe('ProfileManager.focusApp (/app/out/main/profiles.js:5440:12)')
  })

  it('falls back to a dash without a usable frame', () => {
    expect(callerFrame(TRACE_ONLY)).toBe('-')
  })
})

describe('formatActivationEntry', () => {
  const at = Date.UTC(2026, 8, 12, 6, 30, 0)

  it('keeps a Chromium activation to a single line', () => {
    const line = formatActivationEntry({ at, suppressed: false, ignoring: true })
    expect(line.split('\n')).toHaveLength(1)
    expect(line).toContain('ACTIVATED')
    expect(line).toContain('chromium')
    expect(line).toContain('ignoringOtherApps')
  })

  it('marks a swallowed attempt as suppressed', () => {
    expect(formatActivationEntry({ at, suppressed: true, ignoring: false })).toContain('SUPPRESSED')
  })

  it('appends the call path when our own code asked for the foreground', () => {
    const line = formatActivationEntry({ at, suppressed: false, ignoring: false, stack: OURS })
    expect(line).toContain('| app |')
    expect(line).toContain('ProfileManager.focusApp')
    expect(line).toContain('handleCommand')
  })

  it('carries the caller-supplied context', () => {
    const line = formatActivationEntry({
      at,
      suppressed: false,
      ignoring: false,
      context: 'focused=none'
    })
    expect(line).toContain('focused=none')
  })
})
