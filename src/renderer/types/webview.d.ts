declare namespace JSX {
  interface IntrinsicElements {
    webview: WebviewHTMLAttributes
  }

  interface WebviewHTMLAttributes {
    src?: string
    class?: string
    style?: string | Record<string, string>
    partition?: string
    allowpopups?: boolean
    ref?: unknown
  }
}
