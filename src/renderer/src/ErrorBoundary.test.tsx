import { describe, it, expect } from 'vitest'
import { deriveErrorState, ErrorBoundary } from './ErrorBoundary'

describe('deriveErrorState', () => {
  it('flags the error and keeps the Error instance', () => {
    const err = new Error('boom')
    expect(deriveErrorState(err)).toEqual({ hasError: true, error: err })
  })

  it('wraps a non-Error throw so message access is safe', () => {
    const state = deriveErrorState('a string throw')
    expect(state.hasError).toBe(true)
    expect(state.error).toBeInstanceOf(Error)
    expect(state.error?.message).toBe('a string throw')
  })
})

describe('ErrorBoundary.render', () => {
  // React elements are plain objects, so we can inspect the render output without a
  // DOM: the healthy branch returns the children as-is, the error branch returns the
  // fallback <div role="alert">.
  const child = { marker: 'app-tree' }

  it('renders children while healthy', () => {
    const boundary = new ErrorBoundary({ children: child as never })
    expect(boundary.render()).toBe(child)
  })

  it('renders the fallback alert once an error is caught', () => {
    const boundary = new ErrorBoundary({ children: child as never })
    boundary.state = ErrorBoundary.getDerivedStateFromError(new Error('kaboom'))
    const output = boundary.render() as { props: { role?: string } }
    expect(output.props.role).toBe('alert')
  })
})
