/**
 * The app-wide realtime client options, in one place.
 *
 * configure() is app-global and REPLACES the client config wholesale: a page
 * that calls it with only its page-local options silently drops everything
 * the root layout set. Every call site goes through configureApp(), which
 * merges the app defaults under the page's options, so a page can never
 * un-configure the app by accident.
 *
 * The defaults:
 *
 * - resumeGraceMs: when the last subscriber of a stream unsubs, realtime
 *   releases its WS handle but retains the in-memory data model
 *   (currentValue, _lastSeq, _lastVersion, _cursor) for this long. A resub
 *   within the window rides the retained seq into the subscribe envelope and
 *   the server gap-fills from its replay buffer (or via delta.fromSeq for
 *   older gaps) instead of cold-rehydrating. Default is 60s. /demos/from-seq's
 *   replay buffer is 200 events at 1Hz (~200s of coverage); we extend grace
 *   to 10 min so a user can pause past the buffer boundary and still observe
 *   the `fromSeq` tier surface on resume, instead of falling off the cliff
 *   into a cold rehydrate.
 *
 * - protocolVersion: pairs with realtime({ protocolVersion }) in hooks.ws.js
 *   (one shared constant). A tab whose baked version is older than a
 *   freshly-deployed server gets the sticky 'outdated' health state and the
 *   layout's reload banner.
 */
import { configure } from 'svelte-realtime/client'
import { PROTOCOL_VERSION } from '$lib/protocol-version'

/** Merge the app defaults under page-local options and apply. */
export function configureApp(options = {}) {
	configure({
		resumeGraceMs: 600_000,
		protocolVersion: PROTOCOL_VERSION,
		...options
	})
}
