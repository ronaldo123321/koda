/**
 * Public protocol version shared by the TypeScript control plane and the
 * packaged native executor contract. Keep the Rust protocol constant covered
 * by the cross-language golden tests when this value changes.
 */
export const NATIVE_EXECUTOR_PROTOCOL_VERSION = 8 as const;
