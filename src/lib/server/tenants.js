/**
 * The demo's tenants: the two fictional companies /demos/tenants switches a
 * session between. A session's tenant is one of these or null.
 */
export const DEMO_TENANTS = Object.freeze(['acme', 'globex'])

/** @param {unknown} value */
export function isDemoTenant(value) {
	return typeof value === 'string' && DEMO_TENANTS.includes(value)
}

/**
 * Publish an event that every visitor sees, whatever tenant their session
 * carries, from a context without a connection (a cron tick).
 *
 * A connection with a tenant subscribes inside `@t/<tenant>/...`, and a cron
 * has no connection to take a tenant from, so a public event goes out once
 * unscoped and once into each tenant's namespace. Each copy takes the path
 * `ctx.publish` takes: the cluster bus, and the explicit `seq` in `options`.
 *
 * A handler context of a tenant connection publishes inside that tenant, so
 * its `ctx.publish` cannot reach the unscoped namespace; it is refused.
 *
 * @param {{ tenantId?: string | null, publish: (topic: string, event: string, data: any, options?: any) => any, tenant: (id: string) => { publish: (topic: string, event: string, data: any, options?: any) => any } }} ctx
 * @param {string} topic
 * @param {string} event
 * @param {any} data
 * @param {any} [options]
 */
export function publishToEveryScope(ctx, topic, event, data, options) {
	if (ctx.tenantId != null) throw new Error(`publishToEveryScope needs a context without a tenant, got tenant ${ctx.tenantId}`)
	ctx.publish(topic, event, data, options)
	for (const tenantId of DEMO_TENANTS) ctx.tenant(tenantId).publish(topic, event, data, options)
}
