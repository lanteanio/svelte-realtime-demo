/**
 * The interest HUD's reading, derived from two sources that do not share a
 * clock.
 *
 * `/demos/arena` reports how many remote entities a client is receiving out of
 * how many exist. The numerator is the live interest set; the denominator is a
 * population poll that refreshes every couple of seconds. Between polls the
 * world can grow, and a client whose interest set has already taken the new
 * entities in reports more of them than the population it is measured against
 * - "receiving 150 of 149", a fraction above one that no consistent pair can
 * produce and that reads as a broken HUD rather than as a stale denominator.
 *
 * Kept here rather than inline in the page so the impossible pair can be fed
 * to it directly; the race that produces it in the browser arrives at most
 * once per poll interval and only while the world is growing, which is not
 * something a test can wait for honestly.
 */

/**
 * @param {number} receiving remote entities in the live interest set
 * @param {number} population last polled world population, including self
 * @returns {{ receiving: number, total: number, culled: number }}
 */
export function interestReading(receiving, population) {
	const seen = Number.isFinite(receiving) && receiving > 0 ? Math.floor(receiving) : 0
	const polled = Number.isFinite(population) ? Math.floor(population) : 0
	// The floor is evidence rather than a clamp: an interest set holding N
	// remote entities proves the world carries at least N besides this client,
	// so a smaller polled figure is known to be out of date and the live count
	// is the better lower bound. Clamping the percentage instead would leave
	// the impossible pair on screen with a plausible number beside it, which is
	// the worse failure - the reader trusts the part they can check.
	const total = Math.max(0, polled - 1, seen)
	return { receiving: seen, total, culled: total > 0 ? Math.round(100 * (1 - seen / total)) : 0 }
}
