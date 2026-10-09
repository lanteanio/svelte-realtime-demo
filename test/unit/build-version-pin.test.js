import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, posix } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseAst } from 'vite'
import { viteBuild } from '../../scripts/vite-build.mjs'

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
const buildScript = fileURLToPath(new URL('../../scripts/build.mjs', import.meta.url))
let evaluation = 0

async function versionsUnder(version) {
	process.env.SRD_BUILD_VERSION = version
	try {
		const first = (await import(`${configHref}?evaluation=${++evaluation}`)).default
		const second = (await import(`${configHref}?evaluation=${++evaluation}`)).default
		return [first.kit.version.name, second.kit.version.name]
	} finally {
		delete process.env.SRD_BUILD_VERSION
	}
}

// Ends a fake child the way Node ends a real one: 'exit', then 'close' once
// its stdio is done.
function finish(child, code, signal) {
	child.emit('exit', code, signal)
	child.emit('close', code, signal)
}

// Stands in for child_process.spawn: records what the build hands the child,
// then ends it the way `outcome` says.
function fakeSpawn(calls, outcome = (child) => finish(child, 0, null)) {
	return (command, args, options) => {
		calls.push({ command, args, options })
		const child = new EventEmitter()
		queueMicrotask(() => outcome(child))
		return child
	}
}

// No test here takes more than a few seconds, even cold. The bound turns a
// fake child that some change stops listening to into a failure instead of a
// hang.
const QUICK = { timeout: 30_000 }

// The only environment keys the recorder copies out of the child's
// environment. The rest is the caller's own environment, tokens included, and
// has no business in a file.
const RECORDED_ENV = ['SRD_BUILD_VERSION', 'DEMO_NEWS_WEBHOOK_SECRET', 'SRD_TEST_SENTINEL']

const readRepoFile = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')

// vite or svelte-kit as a word of its own, in any letter case (a
// case-insensitive file system resolves VITE too): a command, a path
// segment, a package name or a module specifier. vite's cache directory
// `.vite`, its config files (vite.config.*) and names that only contain the
// word, such as vite-plugin-svelte or vitest, do not match.
const LAUNCH_NAME = /(?<![.\w-])(?:vite|svelte-kit)(?![\w-]|\.config\b)/i

// A repo file parsed as a module, with the top-level consts it declares,
// exported or not, for staticString to look names up in, and the names it
// imports node:path's join under (pathJoins). Comments are not part of the
// tree.
function parseRepoFile(path) {
	const ast = parseAst(readRepoFile(path))
	const consts = new Map()
	for (const statement of ast.body) {
		const declaration = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement
		if (declaration?.type !== 'VariableDeclaration' || declaration.kind !== 'const') continue
		for (const declarator of declaration.declarations) {
			if (declarator.id.type === 'Identifier') consts.set(declarator.id.name, declarator.init)
		}
	}
	return { ast, consts, joins: pathJoins(ast) }
}

// The local names a module imports from node:path (or node:path/posix) that
// reach its join: `join` itself, and the objects join is called on - the
// module's default or namespace import, and its `posix` export.
function pathJoins(ast) {
	const functions = new Set()
	const objects = new Set()
	for (const statement of ast.body) {
		if (statement.type !== 'ImportDeclaration' || !['node:path', 'path', 'node:path/posix', 'path/posix'].includes(statement.source.value)) continue
		for (const specifier of statement.specifiers) {
			if (specifier.type !== 'ImportSpecifier') objects.add(specifier.local.name)
			else if ((specifier.imported.name ?? specifier.imported.value) === 'join') functions.add(specifier.local.name)
			else if ((specifier.imported.name ?? specifier.imported.value) === 'posix') objects.add(specifier.local.name)
		}
	}
	return { functions, objects }
}

// Whether a call is node:path's join, reached through one of pathJoins' names:
// join(...), path.join(...), posix.join(...) or path.posix.join(...). An
// array's .join(), and a join reached through any other name, are not.
// Names are matched without regard to scope, so a local binding that shadows
// one of those names still counts; the recorder's pid check on the lock file
// is what catches a path read that way.
function isPathJoin(call, joins) {
	const { callee } = call
	if (callee.type === 'Identifier') return joins.functions.has(callee.name)
	if (callee.type !== 'MemberExpression' || callee.computed || callee.property.name !== 'join') return false
	const { object } = callee
	if (object.type === 'Identifier') return joins.objects.has(object.name)
	return object.type === 'MemberExpression' && !object.computed && object.property.name === 'posix'
		&& object.object.type === 'Identifier' && joins.objects.has(object.object.name)
}

// Visits every node under `node`, depth first, with the nodes above it.
function walk(node, visit, ancestors = []) {
	visit(node, ancestors)
	const path = [...ancestors, node]
	for (const value of Object.values(node)) {
		for (const child of Array.isArray(value) ? value : [value]) {
			if (typeof child?.type === 'string') walk(child, visit, path)
		}
	}
}

// The name a call is made by: `f` for f(...) and for x.f(...).
function calleeName(call) {
	const { callee } = call
	if (callee.type === 'Identifier') return callee.name
	if (callee.type === 'MemberExpression' && callee.property.type === 'Identifier') return callee.property.name
	return undefined
}

// The string an expression spells without running anything: a string
// literal, a template with no substitutions, a node:path join (isPathJoin)
// whose arguments all spell one, joined as path.posix.join does, or the name
// of a top-level const whose value spells one. undefined for anything else.
function staticString(node, file, seen = new Set()) {
	if (node?.type === 'Literal') return typeof node.value === 'string' ? node.value : undefined
	if (node?.type === 'TemplateLiteral') return node.expressions.length === 0 ? node.quasis[0].value.cooked : undefined
	if (node?.type === 'Identifier') {
		return seen.has(node.name) ? undefined : staticString(file.consts.get(node.name), file, new Set([...seen, node.name]))
	}
	if (node?.type === 'CallExpression' && isPathJoin(node, file.joins)) {
		const parts = node.arguments.map((argument) => staticString(argument, file, seen))
		return parts.every((part) => part !== undefined) ? posix.join(...parts) : undefined
	}
	return undefined
}

// The text of a string literal, or of one fixed piece of a template.
function stringText(node) {
	if (node.type === 'Literal') return typeof node.value === 'string' ? node.value : undefined
	if (node.type === 'TemplateElement') return node.value.cooked ?? node.value.raw
	return undefined
}

const CALLS = ['CallExpression', 'NewExpression', 'ImportExpression', 'TaggedTemplateExpression']
const LOG_PARTS = ['TemplateLiteral', 'LogicalExpression', 'ConditionalExpression', 'ObjectExpression', 'Property', 'ArrayExpression']
const isConsole = (callee) => callee?.type === 'MemberExpression'
	&& callee.object.type === 'Identifier'
	&& callee.object.name === 'console'

// Whether a string is being logged: the nearest call above it - a tagged
// template counts as one - is a console.* call, and between that call and the
// string there is nothing but template literals, `+`, the ?: and logical
// operators, and object and array literals. A string in any other expression
// inside the logged arguments, such as an assignment, another operator or
// another call, is not.
function logged(ancestors) {
	const at = ancestors.findLastIndex((node) => CALLS.includes(node.type))
	const call = ancestors[at]
	const toConsole = call?.type === 'CallExpression' ? isConsole(call.callee)
		: call?.type === 'TaggedTemplateExpression' && isConsole(call.tag)
	return Boolean(toConsole) && ancestors.slice(at + 1).every((node) =>
		LOG_PARTS.includes(node.type) || (node.type === 'BinaryExpression' && node.operator === '+'))
}

// The path scripts/build.mjs hands its first withBuildLock call, relative to
// the directory it runs in; undefined when there is no such call or the path
// is not a staticString. Read from the script, so a lock path that moves, or
// is spelled another way staticString reads, is followed. Names are looked up
// among top-level consts and imports only, so the recorder does not trust the
// path alone: it counts the lock as held only while the file there holds the
// build's own pid, which is what withBuildLock writes into it.
function buildLock() {
	const file = parseRepoFile('scripts/build.mjs')
	const calls = []
	walk(file.ast, (node) => {
		if (node.type === 'CallExpression' && calleeName(node) === 'withBuildLock') calls.push(node)
	})
	return calls.length > 0 ? staticString(calls[0].arguments[0], file) : undefined
}

// Loaded with --import ahead of scripts/build.mjs, so the build's own import
// of spawn resolves to a recorder instead of launching vite. The lock counts
// as held while the file at `lock` exists and its first line is this
// process's pid. The recorder first notes whether anything exists at `lock`
// before the build has run, which it must not. Each spawn appends its own
// line, so a second vite launch is a second record rather than an overwrite
// of the first, and it notes whether the lock is held at that moment; the
// fake vite notes it again as it exits, since a lock released early is still
// held at spawn. The fake vite exits with SRD_TEST_VITE_EXIT, 0 when unset.
// Every other launcher child_process exports is replaced by name, and so is
// ChildProcess.prototype.spawn, which exec, execFile and fork end in and a
// hand-made ChildProcess calls directly. Each of those records a launch and
// then throws, so a second vite started through child_process another way
// still counts against "exactly once"; only the launcher's name is recorded,
// since its arguments can carry the whole environment. A worker thread
// running eval code loads its own child_process without this recorder, so
// worker_threads' Worker is refused the same way: constructing one is
// recorded as a launch and throws.
const recorderSource = (lock) => `
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { EventEmitter } from 'node:events'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
const RECORDED_ENV = ${JSON.stringify(RECORDED_ENV)}
const LOCK = ${JSON.stringify(lock ?? null)}
const locked = () => {
	try {
		return LOCK !== null && readFileSync(LOCK, 'utf8').split('\\n')[0].trim() === String(process.pid)
	} catch {
		return false
	}
}
const record = (line) => appendFileSync(process.env.SRD_TEST_SPAWN_RECORD, JSON.stringify(line) + '\\n')
record({ lockedBeforeBuild: LOCK !== null && existsSync(LOCK) })
const childProcess = createRequire(import.meta.url)('node:child_process')
childProcess.spawn = (command, args, { env = {}, ...options } = {}) => {
	const recordedEnv = Object.fromEntries(RECORDED_ENV.filter((key) => key in env).map((key) => [key, env[key]]))
	record({ via: 'spawn', command, args, options, env: recordedEnv, locked: locked() })
	const child = new EventEmitter()
	const code = Number(process.env.SRD_TEST_VITE_EXIT ?? 0)
	queueMicrotask(() => {
		record({ exited: code, locked: locked() })
		child.emit('exit', code, null)
		child.emit('close', code, null)
	})
	return child
}
for (const via of ['spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
	childProcess[via] = () => {
		record({ via })
		throw new Error('the build script launched a process through ' + via)
	}
}
childProcess.ChildProcess.prototype.spawn = function () {
	record({ via: 'ChildProcess' })
	throw new Error('the build script launched a process through ChildProcess')
}
const workerThreads = createRequire(import.meta.url)('node:worker_threads')
workerThreads.Worker = class {
	constructor() {
		record({ via: 'Worker' })
		throw new Error('the build script started a worker thread')
	}
}
syncBuiltinESMExports()
`

// Run scripts/build.mjs, which is what `npm run build` runs (pinned by the
// first test below), with nothing between it and the spawn but the recorder.
// The working directory is a fresh temp dir that holds the recorder, its
// record and whatever the build creates there, the lock included, so the
// build lock is private to this run, and the relative path the build hands
// node for vite resolves to nothing there even if the recorder failed to take
// the place of spawn.
function runBuildScript(env) {
	const dir = mkdtempSync(join(tmpdir(), 'srd-build-pin-'))
	try {
		const recorder = join(dir, 'record-spawn.mjs')
		const record = join(dir, 'spawns.jsonl')
		writeFileSync(recorder, recorderSource(buildLock()))
		const parentEnv = { ...process.env }
		delete parentEnv.SRD_BUILD_VERSION
		delete parentEnv.DEMO_NEWS_WEBHOOK_SECRET
		delete parentEnv.SRD_TEST_VITE_EXIT
		const result = spawnSync(process.execPath, ['--import', pathToFileURL(recorder).href, buildScript], {
			cwd: dir,
			env: { ...parentEnv, ...env, SRD_TEST_SPAWN_RECORD: record },
			encoding: 'utf8',
			// A build that never settles is killed and reads as status null.
			timeout: 20_000
		})
		const lines = existsSync(record)
			? readFileSync(record, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
			: []
		return {
			status: result.status,
			stderr: result.stderr,
			lockedBeforeBuild: lines.find((line) => 'lockedBeforeBuild' in line)?.lockedBeforeBuild,
			spawns: lines.filter((line) => 'via' in line),
			exits: lines.filter((line) => 'exited' in line)
		}
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
}

// The one child process a successful build starts, which the tests below
// check is vite. The recorder counts every launch it replaces (see
// recorderSource), whatever it starts, so a second vite started that way -
// which could run under another version, the failure the pin exists to
// prevent - fails this, and so does any other process or worker started that
// way.
function onlySpawn(run) {
	assert.equal(run.status, 0, `build script failed: ${run.stderr}`)
	assert.equal(run.spawns.length, 1, 'one build invocation must start exactly one process or worker, the vite build')
	return run.spawns[0]
}

// The Dockerfile's instructions as Docker reads them with its default escape
// character: leading whitespace is ignored, a line ending in a backslash
// continues on the next, and comment and blank lines are skipped, including
// inside a continuation. Keywords come back upper-cased, the leading
// `--flag` options split off from the rest, and whitespace collapsed.
// Heredocs and an `# escape=` directive are not modelled; the Dockerfile
// test refuses both (HEREDOC_WORD, ESCAPE_DIRECTIVE).
function dockerInstructions(text) {
	const instructions = []
	let pending = null
	for (const raw of text.split('\n')) {
		const line = raw.trim()
		if (line === '' || line.startsWith('#')) continue
		const continued = line.endsWith('\\')
		const body = continued ? line.slice(0, -1) : line
		pending = pending === null ? body : `${pending} ${body}`
		if (continued) continue
		const [keyword, ...tokens] = pending.split(/\s+/)
		const flags = []
		while (tokens[0]?.startsWith('--')) flags.push(tokens.shift())
		instructions.push({ keyword: keyword.toUpperCase(), flags, rest: tokens.join(' ') })
		pending = null
	}
	return instructions
}

// The Dockerfile's stages in order: each with its name (lower-cased, null
// when unnamed), its FROM base with the defaults of the ARGs declared before
// the first FROM expanded into it, the earlier stage that base names (null
// otherwise, an image from a registry included), and its instructions, each
// carrying the WORKDIR it runs in. Only $NAME and ${NAME} are expanded, with
// one pair of surrounding quotes taken off the default and nothing else done
// to it, so a base can still hold a `$` afterwards - from an
// ARG with no default, another form such as ${NAME:-word}, or a default that
// is itself a variable. A build-arg that overrides a default at build time is
// not seen. A stage built FROM another starts in that stage's WORKDIR, as in
// Docker.
function dockerStages(instructions) {
	const stages = []
	const globalArgs = new Map()
	for (const instruction of instructions) {
		if (instruction.keyword === 'ARG' && stages.length === 0) {
			for (const declaration of instruction.rest.split(' ')) {
				const [name, ...value] = declaration.split('=')
				if (value.length > 0) globalArgs.set(name, value.join('=').replace(/^(["'])(.*)\1$/, '$2'))
			}
			continue
		}
		if (instruction.keyword === 'FROM') {
			const [written, as, name] = instruction.rest.split(' ')
			const base = written.replace(/\$\{(\w+)\}|\$(\w+)/g, (match, braced, bare) => globalArgs.get(braced ?? bare) ?? match)
			const parent = stageNamed(stages, base)
			stages.push({ name: /^as$/i.test(as ?? '') ? name.toLowerCase() : null, base, parent, workdir: parent?.workdir ?? '/', instructions: [] })
			continue
		}
		const stage = stages.at(-1)
		if (!stage) continue
		if (instruction.keyword === 'WORKDIR') stage.workdir = posix.resolve(stage.workdir, instruction.rest)
		stage.instructions.push({ ...instruction, workdir: stage.workdir })
	}
	return stages
}

// The stage among `stages` a reference names: by name, as a FROM base does,
// or also by index, as a --from= does. null for anything else.
function stageNamed(stages, reference, { byIndex = false } = {}) {
	if (byIndex && /^\d+$/.test(reference)) return stages[Number(reference)] ?? null
	return stages.find((stage) => stage.name === reference.toLowerCase()) ?? null
}

// The stages an instruction reads files from, as written with quotes taken
// off: the value of any --from= flag (COPY takes one), and the from= of a RUN
// --mount.
function stagesReadBy(instruction) {
	return instruction.flags.flatMap((flag) => {
		const copied = /^--from=["']?([^"']+)["']?$/i.exec(flag)
		if (copied) return [copied[1]]
		const mounted = /^--mount=(?:.*,)?["']?from=["']?([^,"']+)/i.exec(flag)
		return mounted ? [mounted[1]] : []
	})
}

// A word that opens a heredoc as BuildKit reads one: optional digits, <<, an
// optional -, then the delimiter, bare, quoted or escaped.
const HEREDOC_WORD = /^\d*<<-?\s*[^<\s]/

// The node options the build script may carry, each one word.
const BUILD_NODE_OPTIONS = /^(?:--(?:max-old-space-size|max-semi-space-size|stack-size)=\d+|--enable-source-maps|--title=[\w.-]+|--(?:no|trace)-warnings|--(?:no|trace|throw|pending)-deprecation|--unhandled-rejections=[\w-]+|--disable-warning=[\w-]+)$/

// A parser directive that changes the escape character, which would change
// what continues a line.
const ESCAPE_DIRECTIVE = /^\s*#\s*escape\s*=/im

// The arguments after an instruction's flags: for a COPY or ADD, its sources
// and then its destination. JSON form when the text is a JSON array of
// strings, as Docker decides it, and split on spaces otherwise.
function dockerArgs(instruction) {
	if (instruction.rest.startsWith('[')) {
		try {
			const parsed = JSON.parse(instruction.rest)
			if (Array.isArray(parsed) && parsed.every((arg) => typeof arg === 'string')) return parsed
		} catch { /* shell form, such as RUN [ -f x ] */ }
	}
	return instruction.rest.split(' ')
}

// A path as path.posix.normalize leaves it (no `./`, no doubled slashes),
// without a trailing slash.
const tidyPath = (path) => posix.normalize(path).replace(/(.)\/$/, '$1')

const isCopy = (instruction) => instruction.keyword === 'COPY' || instruction.keyword === 'ADD'
const spelled = (instruction) => [instruction.keyword, ...instruction.flags, instruction.rest].join(' ')

// The package.json scripts a shell command runs, as this reads it. Words are
// split on whitespace with quotes around them taken off, so a name in quotes,
// or a command inside sh -c "...", is read too. In each part of the command
// between &&, ||, ; and |, after an `npm` word (a path ending in npm, or
// npm@version as npx takes it) and before a lone `--`: every
// word that follows run, run-script, rum or urn and names a script (npm's own
// options may stand before run); or else start, stop, test, t, tst, restart,
// cit, sit, it, install-ci-test, clean-install-test or install-test anywhere
// there, restart counting as stop and start too and the install-and-test
// forms as test; and each of those scripts' pre and post scripts. Also the
// word after `node --run`, or its `--run=` value. Hooks that npm ci or npm
// install run (prepare and the like), other package managers, and a script
// name that is not spelled out in the command are not followed.
function scriptsRunBy(command, scripts) {
	const names = []
	for (const part of command.split(/&&|\|\||[;|\n]/)) {
		const words = part.trim().split(/\s+/).map((word) => word.replace(/^[("']+|[)"']+$/g, ''))
		const npm = words.findIndex((word) => /^(?:.*\/)?npm(?:@\S*)?$/.test(word))
		if (npm >= 0) {
			const tail = words.slice(npm + 1)
			const after = tail.includes('--') ? tail.slice(0, tail.indexOf('--')) : tail
			const run = after.findIndex((word) => ['run', 'run-script', 'rum', 'urn'].includes(word))
			const named = []
			if (run >= 0) {
				named.push(...after.slice(run + 1).filter((word) => !word.startsWith('-')))
			} else {
				for (const word of after) {
					if (['start', 'stop', 'test', 'restart'].includes(word)) named.push(word)
					if (['t', 'tst', 'cit', 'sit', 'it', 'install-ci-test', 'clean-install-test', 'install-test'].includes(word)) named.push('test')
					if (word === 'restart') named.push('stop', 'start')
				}
			}
			names.push(...named.flatMap((name) => [`pre${name}`, name, `post${name}`]))
		}
		const node = words.findIndex((word) => word === 'node' || word.endsWith('/node'))
		for (let i = node + 1; node >= 0 && i < words.length; i++) {
			if (words[i] === '--run' && words[i + 1]) names.push(words[i + 1])
			else if (words[i].startsWith('--run=')) names.push(words[i].slice('--run='.length))
		}
	}
	return names.filter((name) => typeof scripts[name] === 'string')
}

// A RUN's command, and every package.json script scriptsRunBy finds it
// running, followed through the scripts those run in turn. Each entry is
// [where, command text].
function commandsReachedBy(run, scripts) {
	const reached = [['RUN', dockerArgs(run).join(' ')]]
	const seen = new Set()
	for (let i = 0; i < reached.length; i++) {
		for (const name of scriptsRunBy(reached[i][1], scripts)) {
			if (seen.has(name)) continue
			seen.add(name)
			reached.push([`package.json script ${name}`, scripts[name]])
		}
	}
	return reached
}

// Whether a glob, one path segment of a .dockerignore pattern, matches `name`:
// `*` and `?` as wildcards, [...] as a class.
function segmentMatches(glob, name) {
	const pattern = glob.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*+/g, '.*').replace(/\?/g, '.')
	try {
		return new RegExp(`^${pattern}$`).test(name)
	} catch {
		return true
	}
}

test('every build entry point runs scripts/build.mjs: npm run build and the e2e harness', QUICK, () => {
	// Every subprocess test below drives scripts/build.mjs directly. That says
	// something about a real build only while the entry points still go
	// there; one changed to a bare `vite build` would build unpinned with
	// every other test here green.
	//
	// npm hands the build script to a shell, so the script may hold only
	// letters, digits, spaces and . / = : _ -, which leaves the shell nothing
	// to expand, substitute, chain or comment out. Split on spaces it is then
	// `node`, only options from BUILD_NODE_OPTIONS, and scripts/build.mjs or
	// ./scripts/build.mjs, compared as written. The option list is short on
	// purpose: memory sizing, a process title, and how warnings, deprecations
	// and unhandled rejections are handled. Any other option fails here, a
	// harmless one included. The repo's .npmrc, if there is one, sets neither
	// node-options nor script-shell, which would add a preload to every script
	// npm runs or run it with another shell.
	const pkg = JSON.parse(readRepoFile('package.json'))
	const script = pkg.scripts.build ?? ''
	assert.match(script, /^[\w ./=:-]+$/, `the build script may hold only letters, digits, spaces and . / = : _ -: ${script}`)
	const words = script.trim().split(/\s+/)
	assert.ok(words[0] === 'node' && ['scripts/build.mjs', './scripts/build.mjs'].includes(words.at(-1))
		&& words.slice(1, -1).every((option) => BUILD_NODE_OPTIONS.test(option)),
		`the build script must be node, then only options matching ${BUILD_NODE_OPTIONS}, then scripts/build.mjs or ./scripts/build.mjs: ${script}`)
	const npmrc = existsSync(new URL('../../.npmrc', import.meta.url)) ? readRepoFile('.npmrc') : ''
	assert.doesNotMatch(npmrc, /^\s*(?:node[-_]options|script[-_]shell)\s*=/im, '.npmrc may not set node-options or script-shell')
	// npm runs these around `build` on its own, outside the pin.
	for (const hook of ['prebuild', 'postbuild']) {
		assert.equal(pkg.scripts[hook], undefined, `npm run build would also run ${hook}`)
	}
	// The e2e harness builds the tree it serves itself, without npm. Parsed,
	// not imported - importing runs it, and with no tier in argv it prints its
	// usage and exits the process - so its comments are not read. Two rules.
	// An array literal given to a call or a `new` holds the path
	// scripts/build.mjs, as a staticString. And no string in its code names
	// vite or svelte-kit (LAUNCH_NAME) unless a console.* call is logging it
	// (logged). That exemption holds only while the file uses console for
	// nothing but calling its methods: every `console` is the object of a
	// member access that is called (console.x(...) or a tagged console.x`...`),
	// and no string in the file is "console". That catches the harness
	// starting either one by command, path or module specifier. It does not
	// see a name assembled at run time from pieces, or a launch made by a
	// script or npm script the harness runs.
	const harness = parseRepoFile('scripts/run-local-e2e.mjs')
	let consoleOnlyCalled = true
	walk(harness.ast, (node, ancestors) => {
		const [grand, parent] = ancestors.slice(-2)
		const called = parent?.type === 'MemberExpression' && parent.object === node
			&& ((grand?.type === 'CallExpression' && grand.callee === parent) || (grand?.type === 'TaggedTemplateExpression' && grand.tag === parent))
		if (node.type === 'Identifier' && node.name === 'console' && !called) consoleOnlyCalled = false
		if (stringText(node) === 'console') consoleOnlyCalled = false
	})
	let buildArray = false
	const named = []
	walk(harness.ast, (node, ancestors) => {
		if ((node.type === 'CallExpression' || node.type === 'NewExpression') && node.arguments.some((argument) =>
			argument.type === 'ArrayExpression' && argument.elements.some((element) => {
				const path = staticString(element, harness)
				return path !== undefined && tidyPath(path) === 'scripts/build.mjs'
			}))) {
			buildArray = true
		}
		const text = stringText(node)
		if (text !== undefined && LAUNCH_NAME.test(text) && !(consoleOnlyCalled && logged(ancestors))) named.push(text)
	})
	assert.ok(buildArray, 'the e2e harness must give some call an array literal holding the path scripts/build.mjs')
	assert.deepEqual(named, [],
		'no string in the e2e harness code may name vite or svelte-kit unless a console.* call is logging it, in a file that uses console only by calling its methods')
})

test('the image is built by npm run build, and takes only that build from the build stage', QUICK, () => {
	const dockerfile = readRepoFile('Dockerfile')
	assert.doesNotMatch(dockerfile, ESCAPE_DIRECTIVE, 'the Dockerfile may not have an `# escape=` line; dockerInstructions reads only the default escape')
	// A SHELL instruction changes what runs every later RUN, and NODE_OPTIONS
	// or an npm_config_* variable can change what npm run build runs; none may
	// be set anywhere in the Dockerfile.
	const reshaping = dockerInstructions(dockerfile).filter((instruction) => instruction.keyword === 'SHELL'
		|| (['ENV', 'ARG'].includes(instruction.keyword) && /\b(?:NODE_OPTIONS|npm_config_\w*)/i.test(instruction.rest)))
	assert.deepEqual(reshaping.map(spelled), [], 'the Dockerfile may not have a SHELL instruction, or an ENV or ARG naming NODE_OPTIONS or npm_config_*')
	const instructions = dockerInstructions(dockerfile)
	assert.deepEqual(instructions.filter((instruction) => instruction.rest.split(' ').some((word) => HEREDOC_WORD.test(word))).map(spelled), [],
		'the Dockerfile may not have a word matching HEREDOC_WORD; dockerInstructions does not read heredocs')
	const stages = dockerStages(instructions)
	const all = stages.flatMap((stage) => stage.instructions)
	const build = stages.find((stage) => stage.name === 'build')
	assert.ok(build, 'the Dockerfile must have a stage named build')

	// The build stage's last RUN is npm run build, and no COPY or ADD in that
	// stage follows it.
	const lastRun = build.instructions.filter((instruction) => instruction.keyword === 'RUN').at(-1)
	assert.equal(lastRun && dockerArgs(lastRun).join(' '), 'npm run build', 'the last RUN in the build stage must be exactly npm run build')
	const afterBuild = build.instructions.slice(build.instructions.indexOf(lastRun) + 1)
	assert.deepEqual(afterBuild.filter(isCopy).map(spelled), [], 'no COPY or ADD may follow npm run build in the build stage')

	// No RUN in any stage names vite or svelte-kit (LAUNCH_NAME), and neither
	// does any package.json script scriptsRunBy finds a RUN running, followed
	// through the scripts those run in turn.
	const scripts = JSON.parse(readRepoFile('package.json')).scripts ?? {}
	const named = all.filter((instruction) => instruction.keyword === 'RUN')
		.flatMap((run) => commandsReachedBy(run, scripts))
		.filter(([, command]) => LAUNCH_NAME.test(command))
		.map(([where, command]) => `${where}: ${command}`)
	assert.deepEqual(named, [], 'no RUN, and no package.json script scriptsRunBy finds one running, may name vite or svelte-kit')

	// Every stage an instruction reads files from, by --from= or a RUN
	// --mount's from=, is the build stage, by name or by index; and exactly
	// one instruction in the Dockerfile reads it: a COPY of /app/build to
	// build.
	const readers = all.filter((instruction) => stagesReadBy(instruction).length > 0)
	for (const reader of readers) {
		assert.ok(stagesReadBy(reader).every((reference) => stageNamed(stages, reference, { byIndex: true }) === build),
			`files may be taken only from the build stage: ${spelled(reader)}`)
	}
	assert.deepEqual(readers.map((reader) => [reader.keyword, ...dockerArgs(reader).map(tidyPath)]), [['COPY', '/app/build', 'build']],
		'exactly one instruction in the Dockerfile may take files from the build stage: a COPY of /app/build to build')

	// The image is taken to be the last stage of ./Dockerfile, which is what
	// docker compose builds for the app while that service in
	// docker-compose.yml names no dockerfile and no target. Its lineage - the
	// stage, the stage its FROM base names, and so on - does not include the
	// build stage, and every base in it is spelled out once dockerStages has
	// expanded the global ARG defaults into it, since one still holding a `$`
	// cannot be followed.
	const image = stages.at(-1)
	const lineage = []
	for (let stage = image; stage; stage = stage.parent) lineage.push(stage)
	assert.deepEqual(lineage.filter((stage) => stage.base.includes('$')).map((stage) => `FROM ${stage.base}`), [],
		'every FROM base in the image\'s lineage must be spelled out, or through global ARGs with defaults')
	assert.ok(!lineage.includes(build), 'the image, the last stage, must not be built FROM the build stage or from a stage built FROM it')
	const [shipped] = readers
	assert.ok(lineage.some((stage) => stage.instructions.includes(shipped)),
		'the COPY from the build stage must be in the image, or in a stage the image is built FROM')

	// The build lands in build/ under the image's last WORKDIR, the directory
	// the app container starts in while its service names no working_dir.
	// Across the image's lineage, no other COPY or
	// ADD names a destination at or under that directory, each resolved
	// against the WORKDIR it runs in. Variables in a destination or a WORKDIR
	// are not expanded here, so a resolved destination holding a `$` counts
	// against this too. Not looked at: what a RUN writes into that directory,
	// and what a COPY into a parent directory brings along - except for the
	// context's top-level build directory: no Dockerfile.dockerignore exists
	// (Docker would read it in place of .dockerignore), and .dockerignore has
	// a line that reads as build with no later `!` line putting it back. Both
	// are read as Docker reads a pattern: trimmed, with `./`, repeated slashes
	// and leading and trailing slashes dropped; a `!` line puts build back
	// when the first segment of its pattern matches build.
	const target = posix.resolve(shipped.workdir, dockerArgs(shipped).at(-1))
	assert.equal(target, posix.resolve(image.workdir, 'build'), `the build must land in build/ under the image's last WORKDIR, ${image.workdir}`)
	const onto = lineage.flatMap((stage) => stage.instructions)
		.filter((instruction) => isCopy(instruction) && instruction !== shipped)
		.filter((instruction) => {
			const destination = posix.resolve(instruction.workdir, dockerArgs(instruction).at(-1))
			return destination === target || destination.startsWith(`${target}/`) || destination.includes('$')
		})
	assert.deepEqual(onto.map(spelled), [],
		`no other COPY or ADD in the image's lineage may have a destination at or under ${target}, or one spelled with a variable`)
	assert.equal(existsSync(new URL('../../Dockerfile.dockerignore', import.meta.url)), false,
		'there may be no Dockerfile.dockerignore, which Docker reads in place of .dockerignore')
	const cleanPattern = (pattern) => posix.normalize(pattern.trim()).replace(/^\/+|\/+$/g, '')
	const ignored = readRepoFile('.dockerignore').split('\n').map((line) => line.trim())
		.filter((line) => line !== '' && !line.startsWith('#'))
	const leftOut = ignored.findLastIndex((line) => !line.startsWith('!') && cleanPattern(line) === 'build')
	const putBack = ignored.slice(leftOut + 1)
		.filter((line) => line.startsWith('!') && segmentMatches(cleanPattern(line.slice(1)).split('/')[0], 'build'))
	assert.ok(leftOut >= 0 && putBack.length === 0,
		`.dockerignore must have a line that reads as build, and no later ! line whose pattern's first segment matches build: ${putBack.join(', ')}`)
})

test('every evaluation of the config under one pinned build agrees on version.name', QUICK, async () => {
	assert.deepEqual(await versionsUnder('pinned-for-this-test'), ['pinned-for-this-test', 'pinned-for-this-test'])
})

test('scripts/build.mjs hands vite a pinned version, and the config reads exactly that version', QUICK, async () => {
	// The half the config test above cannot see: that the build actually
	// produces the pin and passes it to the process that evaluates the config.
	// An environment without it falls back to Date.now() per evaluation, which
	// is the failure this pin exists to prevent. Driven through the real entry
	// point, so the defaults it relies on are the ones under test.
	assert.ok(buildLock(), 'scripts/build.mjs must call withBuildLock with a path staticString reads: a string, a join imported from node:path, or a top-level const holding one')
	const run = runBuildScript({ SRD_TEST_SENTINEL: 'passed-through' })
	const child = onlySpawn(run)
	assert.equal(child.via, 'spawn')
	assert.equal(run.lockedBeforeBuild, false, 'the lock path must not exist before scripts/build.mjs runs; withBuildLock creates it')
	assert.equal(child.locked, true,
		'vite must run while the lock file holds the build\'s pid on its first line, as withBuildLock writes it; the lock keeps two builds in one checkout apart')
	assert.deepEqual(run.exits, [{ exited: 0, locked: true }], 'the lock file must still hold the build\'s pid when vite exits')
	assert.equal(child.command, process.execPath)
	assert.deepEqual(child.args, ['node_modules/vite/bin/vite.js', 'build'])
	// Everything but the environment, exactly: vite output must reach the
	// operator (an unread pipe can stall it), and a shell or a different cwd
	// would change what the command means.
	assert.deepEqual(child.options, { stdio: 'inherit' })
	assert.equal(child.env.SRD_TEST_SENTINEL, 'passed-through', 'the build must run under the caller\'s environment')
	assert.equal(child.env.DEMO_NEWS_WEBHOOK_SECRET, 'build-analysis-only')
	assert.match(child.env.SRD_BUILD_VERSION ?? '', /^\d+$/, 'the build must pin a version before vite runs')
	assert.deepEqual(await versionsUnder(child.env.SRD_BUILD_VERSION), [child.env.SRD_BUILD_VERSION, child.env.SRD_BUILD_VERSION])
})

test('a version supplied by the operator reaches vite unchanged', QUICK, () => {
	assert.equal(onlySpawn(runBuildScript({ SRD_BUILD_VERSION: 'release-7' })).env.SRD_BUILD_VERSION, 'release-7')
})

test('a failed vite build fails scripts/build.mjs with vite\'s exit code', QUICK, () => {
	// Docker and the e2e harness both judge the build by this process's exit
	// status, so a vite failure that exited 0 here would go on to package or
	// serve whatever the failed build left behind.
	const run = runBuildScript({ SRD_TEST_VITE_EXIT: '3' })
	assert.equal(run.spawns.length, 1, 'one build invocation must start exactly one process or worker, the vite build')
	assert.equal(run.status, 3, 'scripts/build.mjs must exit with the exit code vite exited with')
})

test('an empty version is replaced, not passed through', QUICK, async () => {
	// What an unset Docker ARG forwarded through ENV produces. Passed through,
	// the config would see an empty value and fall back to Date.now() on every
	// evaluation.
	const calls = []
	await viteBuild({ base: { SRD_BUILD_VERSION: '' }, spawn: fakeSpawn(calls) })
	assert.match(calls[0].options.env.SRD_BUILD_VERSION, /^\d+$/)
})

test('each build invocation gets its own version', QUICK, async () => {
	const calls = []
	await viteBuild({ base: {}, spawn: fakeSpawn(calls) })
	await new Promise((resolve) => setTimeout(resolve, 5))
	await viteBuild({ base: {}, spawn: fakeSpawn(calls) })
	assert.notEqual(calls[0].options.env.SRD_BUILD_VERSION, calls[1].options.env.SRD_BUILD_VERSION)
})

test('the build resolves vite\'s exit code, and 1 for a signal or a spawn failure', QUICK, async () => {
	const quiet = console.error
	console.error = () => {}
	try {
		assert.equal(await viteBuild({ base: {}, spawn: fakeSpawn([], (child) => finish(child, 2, null)) }), 2)
		assert.equal(await viteBuild({ base: {}, spawn: fakeSpawn([], (child) => finish(child, null, 'SIGTERM')) }), 1)
		assert.equal(await viteBuild({ base: {}, spawn: fakeSpawn([], (child) => child.emit('error', new Error('ENOENT'))) }), 1)
	} finally {
		console.error = quiet
	}
})
