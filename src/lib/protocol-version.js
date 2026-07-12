/**
 * The app's wire/contract version, shared by the server (realtime({
 * protocolVersion })) and the client (configure({ protocolVersion })).
 * Bump ONLY on a breaking wire/contract change: a connecting client baked
 * with an older number gets a one-shot protocol-stale notice and the
 * layout shows its "new version available - reload" banner.
 */
export const PROTOCOL_VERSION = 1
