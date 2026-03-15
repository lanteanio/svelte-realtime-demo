/**
 * Random identity and slug generation.
 *
 * Users get a random name (like "Cosmic Penguin") and color on first visit.
 * Boards get a random slug (like "cosmic-penguin-742") for their URL.
 *
 * 30 adjectives x 30 nouns = 900 name combinations. Collisions are harmless
 * because names are just for display, not authentication. The UUID in the
 * identity cookie is what uniquely identifies a user.
 *
 * Slug collisions ARE handled -- see boards.js which retries up to 5 times
 * with different random slugs if a duplicate is generated.
 */

const adjectives = [
	'Cosmic', 'Turbo', 'Sleepy', 'Funky', 'Wobbly', 'Sneaky', 'Dizzy', 'Fluffy',
	'Grumpy', 'Zappy', 'Bouncy', 'Crispy', 'Fizzy', 'Jazzy', 'Mighty', 'Peppy',
	'Quirky', 'Sassy', 'Toasty', 'Wacky', 'Zippy', 'Breezy', 'Cheeky', 'Dapper',
	'Groovy', 'Snappy', 'Spunky', 'Swanky', 'Nifty', 'Plucky'
]

const nouns = [
	'Penguin', 'Mango', 'Wizard', 'Waffle', 'Narwhal', 'Pickle', 'Llama', 'Donut',
	'Panda', 'Taco', 'Otter', 'Pretzel', 'Falcon', 'Nugget', 'Badger', 'Biscuit',
	'Cactus', 'Dumpling', 'Gecko', 'Hamster', 'Igloo', 'Jellyfish', 'Koala', 'Lobster',
	'Muffin', 'Noodle', 'Platypus', 'Quokka', 'Starfish', 'Turnip'
]

const colors = [
	'#3b82f6', '#ef4444', '#22c55e', '#f59e0b', '#8b5cf6',
	'#ec4899', '#14b8a6', '#f97316', '#6366f1', '#84cc16'
]

/** Generate a random display name and color for a new user. */
export function generateIdentity() {
	const adj = adjectives[Math.floor(Math.random() * adjectives.length)]
	const noun = nouns[Math.floor(Math.random() * nouns.length)]
	const color = colors[Math.floor(Math.random() * colors.length)]
	return { name: `${adj} ${noun}`, color }
}

/** Generate a URL-safe slug like "plucky-taco-576" for a new board. */
export function generateSlug() {
	const adj = adjectives[Math.floor(Math.random() * adjectives.length)].toLowerCase()
	const noun = nouns[Math.floor(Math.random() * nouns.length)].toLowerCase()
	const n = Math.floor(Math.random() * 900) + 100
	return `${adj}-${noun}-${n}`
}
