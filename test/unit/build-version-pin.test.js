import assert from 'node:assert/strict'
import test from 'node:test'

// The failure this exists for: kit compiles the client's hydration-payload
// access to globalThis.__sveltekit_<hash(version.name)>, and version.name
// defaults to Date.now() at config evaluation - so a config evaluated more
// than once inside a single build can ship a client that reads another
// evaluation's global and hydrates nothing on any page. The property under
// test is agreement: however many times the config is evaluated under one
// pinned build environment, every evaluation resolves the same version.
//
// Each import carries a cache-busting query so it genuinely re-evaluates the
// module rather than replaying the first evaluation from the module cache -
// without that, the second read is the first one wearing a disguise and the
// test cannot fail.

const configHref = new URL('../../svelte.config.js', import.meta.url).href

test('every evaluation of the config under one pinned build agrees on version.name', async () => {
	process.env.SRD_BUILD_VERSION = 'pinned-for-this-test'
	try {
		const first = (await import(`${configHref}?evaluation=1`)).default
		const second = (await import(`${configHref}?evaluation=2`)).default
		assert.equal(first.kit.version.name, 'pinned-for-this-test')
		assert.equal(second.kit.version.name, first.kit.version.name)
	} finally {
		delete process.env.SRD_BUILD_VERSION
	}
})
