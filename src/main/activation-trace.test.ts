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
