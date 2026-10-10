export async function startProjectReplicas(project, replicaCount, { freePort, startApp }) {
	const count = project === 'cluster' || project === 'diagnostics' ? replicaCount : 1
	const origins = []
	for (let index = 0; index < count; index++) {
		const port = await freePort()
		await startApp(port)
		origins.push(`http://127.0.0.1:${port}`)
	}
	// Empty targets override ambient values from a previous, larger topology.
	return Object.fromEntries(['BASE_URL', 'INSTANCE_B', 'INSTANCE_C', 'INSTANCE_D'].map((name, index) => [
		name, origins[index] ?? ''
	]))
}
