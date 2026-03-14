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

export function generateIdentity() {
	const adj = adjectives[Math.floor(Math.random() * adjectives.length)]
	const noun = nouns[Math.floor(Math.random() * nouns.length)]
	const color = colors[Math.floor(Math.random() * colors.length)]
	return { name: `${adj} ${noun}`, color }
}

export function generateSlug() {
	const adj = adjectives[Math.floor(Math.random() * adjectives.length)].toLowerCase()
	const noun = nouns[Math.floor(Math.random() * nouns.length)].toLowerCase()
	const n = Math.floor(Math.random() * 900) + 100
	return `${adj}-${noun}-${n}`
}
