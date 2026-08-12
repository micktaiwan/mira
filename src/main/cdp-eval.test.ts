import { describe, it, expect } from 'vitest'
import { interpretRuntimeEvaluate, PageEvalError } from './cdp-eval'

describe('interpretRuntimeEvaluate', () => {
  it('returns a serialized value (returnByValue)', () => {
    expect(interpretRuntimeEvaluate({ result: { type: 'number', value: 2 } })).toBe(2)
    expect(interpretRuntimeEvaluate({ result: { type: 'string', value: 'hi' } })).toBe('hi')
    expect(interpretRuntimeEvaluate({ result: { type: 'object', value: { a: 1 } } })).toEqual({
      a: 1
    })
  })

  it('returns undefined when value is literally undefined', () => {
    expect(interpretRuntimeEvaluate({ result: { type: 'undefined', value: undefined } })).toBe(
      undefined
    )
  })

  it('falls back to description when no value was serialized', () => {
    expect(
      interpretRuntimeEvaluate({ result: { type: 'function', description: 'function f() {}' } })
    ).toBe('function f() {}')
  })

  it('throws the page exception description', () => {
    expect(() =>
      interpretRuntimeEvaluate({
        exceptionDetails: {
          text: 'Uncaught',
          exception: { description: 'ReferenceError: x is not defined' }
        }
      })
    ).toThrow('ReferenceError: x is not defined')
  })

  it('throws a thrown string value when there is no description', () => {
    expect(() =>
      interpretRuntimeEvaluate({
        exceptionDetails: { text: 'Uncaught', exception: { value: 'boom' } }
      })
    ).toThrow('boom')
  })

  it('throws the top-level text when the exception has neither', () => {
    expect(() => interpretRuntimeEvaluate({ exceptionDetails: { text: 'Syntax error' } })).toThrow(
      'Syntax error'
    )
  })

  it('returns undefined on an empty reply (no result, no exception)', () => {
    expect(interpretRuntimeEvaluate({})).toBe(undefined)
  })

  it('tags a page-side failure as PageEvalError so the caller skips the fallback', () => {
    expect(() =>
      interpretRuntimeEvaluate({
        exceptionDetails: { text: 'Uncaught', exception: { description: 'TypeError: x is null' } }
      })
    ).toThrow(PageEvalError)
  })

  it('explains that a redeclaration comes from the shared execution context', () => {
    let thrown: unknown
    try {
      interpretRuntimeEvaluate({
        exceptionDetails: {
          text: 'Uncaught',
          exception: { description: "SyntaxError: Identifier 'ta' has already been declared" }
        }
      })
    } catch (error) {
      thrown = error
    }
    const message = (thrown as Error).message
    expect(message).toContain("Identifier 'ta' has already been declared")
    expect(message).toContain('IIFE')
  })

  it('leaves an unrelated message untouched', () => {
    expect(() =>
      interpretRuntimeEvaluate({
        exceptionDetails: { exception: { description: 'ReferenceError: y is not defined' } }
      })
    ).toThrow('ReferenceError: y is not defined')
  })
})
