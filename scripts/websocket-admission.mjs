/** Keep high-volume local test admission out of deployable builds. */
export function websocketAdmission(env = process.env) {
	const localHarness = env.SRD_LOCAL_LOAD_TEST === '1'
		&& /^build-runs[\\/]srd-build-\d+-\d+$/.test(env.BUILD_OUT_DIR ?? '')
	return {
		upgradeRateLimit: localHarness ? 0 : 100,
		authPathRateLimit: localHarness ? 0 : 300,
		upgradeAdmission: {
			maxConcurrent: localHarness ? 4000 : 128,
			maxConnections: localHarness ? 12000 : 2000,
			perTickBudget: localHarness ? 256 : 64,
			maxDeferred: localHarness ? 4000 : 128
		}
	}
}
