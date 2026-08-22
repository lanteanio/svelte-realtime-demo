/**
 * /demos/todos-rollback - the one fact the server, the page and the test all
 * have to agree on.
 *
 * The forced failure is deliberately slowed. A rejection thrown at the top of
 * the handler comes back in the time of one connection, tens of milliseconds,
 * so the visitor sees a toast and an unchanged list and the demo's central
 * observable - an optimistic row rolling back independently of its neighbours -
 * is never actually observed. This is the artificial half of an artificial
 * failure, so slowing it costs nothing real and is the only thing that makes
 * the arc perceivable.
 *
 * It lives here rather than in the handler because the page TEACHES the number:
 * the mechanism note tells a visitor how long the handler waits, and a note
 * that disagrees with the handler is the demo teaching something the code does
 * not do. Three independent literals - one in the handler, one in the copy, one
 * in the regression - agree until somebody changes one of them, and nothing
 * fails when they stop agreeing. One exported constant is what makes the
 * disagreement impossible rather than merely unlikely.
 */
export const FORCED_FAIL_DELAY_MS = 400

/**
 * How long an error toast stays on screen.
 *
 * Shared for the same reason as the delay above, and with a sharper edge: the
 * toast sits OVER the list it is reporting on, so its lifetime is the length of
 * time the demo obscures its own subject. A regression that stretched it would
 * be invisible to a test that only asks whether the toast eventually leaves -
 * and 'eventually' was ten seconds against a declared three and a half, which
 * accepts a toast outliving its contract by a factor of three.
 */
export const TOAST_MS = 3500
