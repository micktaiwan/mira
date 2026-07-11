// JSX typing for the <browser-action-list> custom element injected by
// electron-chrome-extensions (see ExtensionActions.tsx). React 19 passes
// unknown attributes straight through to custom elements.

declare namespace React.JSX {
  interface IntrinsicElements {
    'browser-action-list': React.DetailedHTMLProps<
      React.HTMLAttributes<HTMLElement> & {
        /** Session partition whose extensions to show (defaults to the session
         * the element lives in — ALWAYS set it for non-default profiles). */
        partition?: string
        /** WebContents id of the tab to reflect; defaults to the active tab. */
        tab?: string
        /** Popup anchor corner, e.g. "bottom right". */
        alignment?: string
      },
      HTMLElement
    >
  }
}
