declare global {
  interface Window {
    // Derived from the shared surface builder — the daemon RPC registry
    // (rpc-schema.ts) is the single source of truth for params and results.
    bond: import('../shared/bond-surface').BondSurface
  }
}

export {}
