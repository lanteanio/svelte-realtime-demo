import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, posix, relative, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseAst } from 'vite'
import { buildOutDir, versionHashMismatch } from '../../scripts/build-output.mjs'
import { buildEnvironment, viteBuild } from '../../scripts/vite-build.mjs'

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
// Exiting 0, it first writes the two halves of a build for the build's own
// check to read, taking every setting from the environment handed to it, as
// the adapter takes its directory from the config vite evaluates: in
// SRD_TEST_OUTPUT_DIR, else BUILD_OUT_DIR, else build, a server/index.js
// holding version_hash: "<SRD_TEST_SERVER_HASH>" beside the two other
// __sveltekit_ spellings a real server carries (the service worker global and
// the template that builds the payload's name), and a
// client/_app/immutable/chunks/start.js reading
// globalThis.__sveltekit_<SRD_TEST_CLIENT_HASH>. The server hash is pinned1
// when unset and the client hash the server's; SRD_TEST_NO_OUTPUT=1 writes
// neither half. Every fs.readdirSync and fs.readFileSync call in the build's
// process is recorded with its path passed through path.resolve and then
// path.relative from the build working directory, and whether the lock is
// held at that moment. Windows namespaced and UNC paths are not mapped to
// equivalent drive-letter paths.
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
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const RECORDED_ENV = ${JSON.stringify(RECORDED_ENV)}
const LOCK = ${JSON.stringify(lock ?? null)}
const fs = createRequire(import.meta.url)('node:fs')
// Taken before fs.readFileSync is wrapped below, so reading the lock is not
// itself recorded as a read.
const readFileUnrecorded = fs.readFileSync
const locked = () => {
	try {
		return LOCK !== null && readFileUnrecorded(LOCK, 'utf8').split('\\n')[0].trim() === String(process.pid)
	} catch {
		return false
	}
}
const record = (line) => appendFileSync(process.env.SRD_TEST_SPAWN_RECORD, JSON.stringify(line) + '\\n')
const writeOutput = (env) => {
	if (env.SRD_TEST_NO_OUTPUT === '1') return
	const out = env.SRD_TEST_OUTPUT_DIR || env.BUILD_OUT_DIR || 'build'
	const server = env.SRD_TEST_SERVER_HASH || 'pinned1'
	const client = env.SRD_TEST_CLIENT_HASH || server
	mkdirSync(join(out, 'server'), { recursive: true })
	mkdirSync(join(out, 'client', '_app', 'immutable', 'chunks'), { recursive: true })
	writeFileSync(join(out, 'server', 'index.js'), 'const options = {\\n  version_hash: "' + server + '"\\n}\\n'
		+ 'const sw = globalThis.__sveltekit_sw\\nconst prefix = "__sveltekit_$"\\n')
	writeFileSync(join(out, 'client', '_app', 'immutable', 'chunks', 'start.js'), 'const base = globalThis.__sveltekit_' + client + '?.base ?? ""\\n')
}
const readdir = fs.readdirSync
const spelled = (path) => relative(process.cwd(), resolve(path instanceof URL ? fileURLToPath(path) : String(path)))
fs.readdirSync = function (path, ...rest) {
	record({ readdir: spelled(path), locked: locked() })
	return readdir.call(this, path, ...rest)
}
fs.readFileSync = function (path, ...rest) {
	record({ readFile: spelled(path), locked: locked() })
	return readFileUnrecorded.call(this, path, ...rest)
}
record({ lockedBeforeBuild: LOCK !== null && existsSync(LOCK) })
const childProcess = createRequire(import.meta.url)('node:child_process')
childProcess.spawn = (command, args, { env = {}, ...options } = {}) => {
	const recordedEnv = Object.fromEntries(RECORDED_ENV.filter((key) => key in env).map((key) => [key, env[key]]))
	record({ via: 'spawn', command, args, options, env: recordedEnv, locked: locked() })
	const child = new EventEmitter()
	const code = Number(process.env.SRD_TEST_VITE_EXIT ?? 0)
	queueMicrotask(() => {
		if (code === 0) writeOutput(env)
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
		for (const key of ['BUILD_OUT_DIR', 'SRD_TEST_OUTPUT_DIR', 'SRD_TEST_SERVER_HASH', 'SRD_TEST_CLIENT_HASH', 'SRD_TEST_NO_OUTPUT']) delete parentEnv[key]
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
			dir,
			status: result.status,
			stderr: result.stderr,
			lockedBeforeBuild: lines.find((line) => 'lockedBeforeBuild' in line)?.lockedBeforeBuild,
			spawns: lines.filter((line) => 'via' in line),
			exits: lines.filter((line) => 'exited' in line),
			reads: lines.filter((line) => 'readdir' in line || 'readFile' in line)
		}
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
}

// "under <dir>:" for a directory of a run's build output, as the check's
// message names it: relative to the run's working directory, or absolute
// within it.
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
function namedUnder(run, ...parts) {
	return new RegExp(`under (?:${escapeRegExp(join(...parts))}|${escapeRegExp(join(run.dir, ...parts))}):`)
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

// The Dockerfile's instructions as BuildKit reads them with its default escape
// character. An instruction's first line loses its leading whitespace. A line
// ending in a backslash, trailing spaces or tabs allowed, continues on the
// next, which is appended as it stands: its own leading whitespace kept and
// nothing put in between, so a word split across two lines is one word.
// Comment and blank lines are skipped, inside a continuation too. Keywords
// come back upper-cased, the leading `--flag` options split off from the
// rest, and whitespace collapsed. Heredocs and parser directives are not
// modelled; the Dockerfile test refuses both (HEREDOC_WORD,
// PARSER_DIRECTIVE).
function dockerInstructions(text) {
	const instructions = []
	let pending = null
	for (const raw of text.split('\n')) {
		const line = raw.replace(/\r$/, '')
		const trimmed = line.trim()
		if (trimmed === '' || trimmed.startsWith('#')) continue
		const continued = /\\[ \t]*$/.test(line)
		const body = (pending === null ? line.trimStart() : line).replace(/\\[ \t]*$/, '')
		pending = pending === null ? body : pending + body
		if (continued) continue
		instructions.push(dockerInstruction(pending))
		pending = null
	}
	// A continuation that runs into the end of the file still ends the
	// instruction; BuildKit runs it.
	if (pending !== null && pending.trim() !== '') instructions.push(dockerInstruction(pending))
	return instructions
}

// One instruction's text as dockerInstructions returns it.
function dockerInstruction(text) {
	const [keyword, ...tokens] = text.trim().split(/\s+/)
	const flags = []
	while (tokens[0]?.startsWith('--')) flags.push(tokens.shift())
	return { keyword: keyword.toUpperCase(), flags, rest: tokens.join(' ') }
}

// An instruction's text split into words on whitespace outside quotes, each
// word as written: quotes and backslashes kept, a backslash also keeping the
// character after it in the word.
function dockerWords(text) {
	const words = []
	let word = ''
	let quote = null
	for (let i = 0; i < text.length; i++) {
		const c = text[i]
		if (c === '\\' && quote !== "'" && i + 1 < text.length) {
			word += c + text[++i]
		} else if (quote) {
			if (c === quote) quote = null
			word += c
		} else if (c === '"' || c === "'") {
			quote = c
			word += c
		} else if (/\s/.test(c)) {
			if (word !== '') words.push(word)
			word = ''
		} else {
			word += c
		}
	}
	if (word !== '') words.push(word)
	return words
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

// Recognised parser-directive spellings, with case-insensitive keys and
// optional whitespace. Refuse these comment lines anywhere, including where
// Docker would ignore them: another frontend, escape character or lint mode
// is outside this reader.
const PARSER_DIRECTIVE = /^[ \t]*#[ \t]*(?:syntax|escape|check)[ \t]*=/im

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
// split on whitespace with quotes and parentheses at either end taken off, so
// a name in quotes, a command inside sh -c "..." or a ( subshell ) is read
// too, while npm glued to a $( or a backtick, as in $(npm, is not read as
// npm. Only the first npm word in each part counts, so npm exec -- npm run
// ... is not followed. In each part of the command
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

// Read only block mappings at the named indentation. Values and nested lines
// outside the build declarations are not interpreted. Quoted keys, aliases,
// merges and flow mappings at these levels fail instead of hiding a build.
function composeEntries(lines, indent, location) {
	const entries = new Map()
	let entry
	for (const line of lines) {
		if (!line.trim() || line.trimStart().startsWith('#')) continue
		assert.ok(!/^\s*\t/.test(line), `${location}: tabs in indentation are not supported`)
		const depth = line.length - line.trimStart().length
		if (depth > indent) {
			assert.ok(entry, `${location}: unexpected nested line`)
			entry.lines.push(line)
			continue
		}
		const match = /^([A-Za-z0-9_-]+):(?:\s+(.*))?$/.exec(line.slice(indent).trimEnd())
		assert.ok(depth === indent && match, `${location}: expected a plain block-mapping key: ${line}`)
		assert.ok(!entries.has(match[1]), `${location}: duplicate key ${match[1]}`)
		entry = { value: (match[2] ?? '').replace(/\s+#.*$/, '').trim(), lines: [] }
		entries.set(match[1], entry)
	}
	return entries
}

function composePath(value, location) {
	const match = /^(?:((?:[A-Za-z]:)?[A-Za-z0-9._/-]+)|'((?:[A-Za-z]:)?[A-Za-z0-9._/ -]+)'|"((?:[A-Za-z]:)?[A-Za-z0-9._/ -]+)")$/.exec(value)
	assert.ok(match, `${location}: expected a literal path without interpolation or YAML escapes`)
	return posix.normalize(match[1] ?? match[2] ?? match[3])
}

function rootContextDockerfiles(read = readRepoFile, root = fileURLToPath(new URL('../../', import.meta.url))) {
	const files = new Set()
	const builds = new Map()
	for (const name of ['docker-compose.yml', 'docker-compose.rollback.yml']) {
		const top = composeEntries(read(name).split('\n'), 0, name)
		assert.ok(!top.has('include'), `${name}: included Compose files must be checked explicitly`)
		const services = top.get('services')
		assert.ok(services && services.value === '', `${name}: services must be a block mapping`)
		for (const [service, declaration] of composeEntries(services.lines, 2, `${name} services`)) {
			const location = `${name} service ${service}`
			assert.equal(declaration.value, '', `${location}: service must be a block mapping`)
			const fields = composeEntries(declaration.lines, 4, location)
			assert.ok(!fields.has('extends'), `${location}: extended services must be checked explicitly`)
			const build = fields.get('build')
			if (!build) continue
			assert.ok(build.value === '' || build.lines.length === 0, `${location}: a short build context cannot have nested lines`)
			const declared = build.value === '' ? composeEntries(build.lines, 6, `${location} build`)
				: new Map([['context', { value: build.value }]])
			// Compose merges build mappings by service: a rollback context can
			// change while its Dockerfile stays inherited from the base file.
			const options = new Map([...(builds.get(service) ?? []), ...declared])
			builds.set(service, options)
			assert.ok(!options.has('dockerfile_inline'), `${location}: inline Dockerfiles are not supported by this check`)
			for (const key of ['context', 'dockerfile']) {
				assert.ok(!options.get(key)?.lines?.length, `${location} ${key}: expected a single-line literal path`)
			}
			const context = composePath(options.get('context')?.value || '.', `${location} context`)
			if (relative(root, resolve(root, context)) !== '') continue
			const dockerfile = composePath(options.get('dockerfile')?.value || 'Dockerfile', `${location} dockerfile`)
			assert.ok(!posix.isAbsolute(dockerfile) && !/^[A-Za-z]:/.test(dockerfile) && dockerfile !== '..' && !dockerfile.startsWith('../'),
				`${location}: Dockerfile must be inside the repository`)
			files.add(dockerfile)
		}
	}
	assert.ok(files.size > 0, 'Compose must declare at least one repository-root build context')
	return files
}

test('Compose build contexts include equivalent root paths and inherited Dockerfiles', QUICK, () => {
	const root = resolve('/compose-fixtures/demo')
	const absoluteRoot = resolve(root).replaceAll('\\', '/')
	for (const context of ['.', './', 'nested/../', "'.'", '"./"', `../${basename(root)}`, `'${absoluteRoot}'`]) {
		const base = `services:
  app:
    build: .
  database:
    build:
      context: nested
      dockerfile: Dockerfile.database
`
		const rollback = `services:
  database:
    build:
      context: ${context}
`
		const read = (name) => name === 'docker-compose.yml' ? base : rollback
		assert.deepEqual([...rootContextDockerfiles(read, root)], ['Dockerfile', 'Dockerfile.database'],
			`rollback context ${context} must retain its inherited Dockerfile`)
	}
})

test('Compose root aliases are checked in both short and mapping build forms', QUICK, () => {
	const root = resolve('/compose-fixtures/demo')
	for (const context of [`../${basename(root)}`, `'${root.replaceAll('\\', '/')}'`]) {
		for (const build of [`build: ${context}`, `build:\n      context: ${context}\n      dockerfile: Dockerfile.postgres`]) {
			const read = (name) => name === 'docker-compose.yml'
				? `services:\n  postgres:\n    ${build}\n` : 'services:\n  postgres:\n    image: postgres\n'
			assert.deepEqual([...rootContextDockerfiles(read, root)], [build.includes('dockerfile:') ? 'Dockerfile.postgres' : 'Dockerfile'])
		}
	}
	const read = (name) => name === 'docker-compose.yml'
		? 'services:\n  app:\n    build: .\n  migrations:\n    build:\n      context: ./migrations\n      dockerfile: Dockerfile.migrations\n'
		: 'services:\n  app:\n    image: app\n'
	assert.deepEqual([...rootContextDockerfiles(read)], ['Dockerfile'])
})

test('Compose context and Dockerfile scalars cannot hide on nested lines', QUICK, () => {
	for (const name of ['docker-compose.yml', 'docker-compose.rollback.yml']) {
		const read = (file) => file === name
			? 'services:\n  postgres:\n    build: migrations\n      /..\n'
			: 'services:\n  app:\n    build: .\n  postgres:\n    build:\n      context: migrations\n      dockerfile: Dockerfile.postgres\n'
		assert.throws(() => rootContextDockerfiles(read), /a short build context cannot have nested lines/)
	}
	for (const [key, path] of [['dockerfile', 'Dockerfile.postgres'], ['context', './migrations']]) {
		for (const name of ['docker-compose.yml', 'docker-compose.rollback.yml']) {
			const read = (file) => file === name
				? `services:\n  postgres:\n    build:\n      ${key}:\n        ${path}\n`
				: 'services:\n  postgres:\n    build: .\n'
			assert.throws(() => rootContextDockerfiles(read), new RegExp(`${key}: expected a single-line literal path`))
		}
	}
})

test('Compose Dockerfiles cannot use drive-letter paths', QUICK, () => {
	for (const name of ['docker-compose.yml', 'docker-compose.rollback.yml']) {
		const read = (file) => file === name
			? 'services:\n  postgres:\n    build:\n      context: .\n      dockerfile: C:/Dockerfile.postgres\n'
			: 'services:\n  postgres:\n    build: .\n'
		assert.throws(() => rootContextDockerfiles(read), /Dockerfile must be inside the repository/)
	}
})

// The rule for leaving the top-level directory `dir` out of the Docker build
// context, checked as written and failing closed:
// - for each repository-root build in docker-compose.yml and
//   docker-compose.rollback.yml, no <dockerfile>.dockerignore exists (Docker
//   reads it in place of .dockerignore); omitted dockerfile means Dockerfile
//   unless inherited by the merged rollback build mapping;
// - literal build contexts resolve against the checkout directory, including
//   parent-relative and absolute aliases; nested context/dockerfile scalars
//   require reader support rather than silently falling back to defaults;
// - .dockerignore holds only printable ASCII, tabs and line breaks, a
//   byte-order mark at the very start aside;
// - a trimmed line is exactly `dir`, `/dir`, `./dir`, `dir/`, `/dir/` or
//   `./dir/`;
// - every `!` line spells its pattern, right after the `!`, with letters,
//   digits, `.`, `_`, `-`, `/` and `*` only, and that pattern's first segment,
//   once resolved by posix.normalize and stripped of leading and trailing
//   slashes, is a name of letters, digits, `.`, `_` and `-`
//   that is neither all dots nor `dir`.
// Docker compiles a pattern to a regular expression in which characters such
// as `[`, `^`, `?` or a backslash keep a meaning of their own, and Docker
// and this reader trim characters outside ASCII differently. None of that is
// modelled here, so a `!` line holding such a character, or any line holding
// a character outside ASCII, fails even where Docker would still leave
// `dir` out. A `*` in a later segment of a `!` pattern is not looked at:
// the path it matches still starts with the first segment's name.
function assertContextLeavesOut(dir) {
	for (const dockerfile of rootContextDockerfiles()) {
		const override = `${dockerfile}.dockerignore`
		assert.equal(existsSync(new URL(`../../${override}`, import.meta.url)), false,
			`there may be no ${override}, which Docker reads in place of .dockerignore`)
	}
	const read = readRepoFile('.dockerignore')
	const text = read.charCodeAt(0) === 0xfeff ? read.slice(1) : read
	const odd = /[^\t\r\n -~]/.exec(text)
	assert.equal(odd, null,
		`.dockerignore may hold only printable ASCII, tabs and line breaks: found U+${odd?.[0].codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`)
	const cleanPattern = (pattern) => posix.normalize(pattern.trim()).replace(/^\/+|\/+$/g, '')
	const ignored = text.split('\n').map((line) => line.trim())
		.filter((line) => line !== '' && !line.startsWith('#'))
	const exclusions = [dir, `/${dir}`, `./${dir}`, `${dir}/`, `/${dir}/`, `./${dir}/`]
	const leftOut = ignored.some((line) => exclusions.includes(line))
	const unsafe = ignored.filter((line) => {
		if (!line.startsWith('!')) return false
		const pattern = line.slice(1)
		const first = cleanPattern(pattern).split('/')[0]
		return !/^[A-Za-z0-9._\-/*]+$/.test(pattern) || !/^[A-Za-z0-9._-]+$/.test(first) || /^\.+$/.test(first) || first === dir
	})
	assert.ok(leftOut && unsafe.length === 0,
		`.dockerignore must include one of ${exclusions.join(', ')}, and every ! line must use only letters, digits, . _ - / and *, with a resolved first segment that is a plain name (no *, not all dots) other than ${dir}${unsafe.length ? `: ${unsafe.join(', ')}` : ''}`)
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
	// purpose: memory sizing, a process title, source maps, and how warnings,
	// deprecations and unhandled rejections are handled. Any other option fails
	// here, a harmless one included.
	//
	// The repo's .npmrc, if there is one, may set only keys on a short list of
	// settings that govern installs and output, never what a script runs.
	// Lines are split on any run of CR and LF characters, as npm's ini reader
	// splits them; a line whose first non-blank character is ; or # is a
	// comment; a key is the text before the first `=`, trimmed, and must be
	// lower-case letters, digits and - as written, so a quoted, escaped,
	// bracketed or commented key, which ini reads differently, is refused
	// whatever it would mean.
	const pkg = JSON.parse(readRepoFile('package.json'))
	const script = pkg.scripts.build ?? ''
	assert.match(script, /^[\w ./=:-]+$/, `the build script may hold only letters, digits, spaces and . / = : _ -: ${script}`)
	const words = script.trim().split(/\s+/)
	assert.ok(words[0] === 'node' && ['scripts/build.mjs', './scripts/build.mjs'].includes(words.at(-1))
		&& words.slice(1, -1).every((option) => BUILD_NODE_OPTIONS.test(option)),
		`the build script must be node, then only options matching ${BUILD_NODE_OPTIONS}, then scripts/build.mjs or ./scripts/build.mjs: ${script}`)
	const npmrc = existsSync(new URL('../../.npmrc', import.meta.url)) ? readRepoFile('.npmrc') : ''
	const NPMRC_KEYS = ['engine-strict', 'fund', 'audit', 'loglevel', 'progress', 'update-notifier', 'save-exact', 'save-prefix', 'package-lock', 'legacy-peer-deps', 'strict-peer-deps']
	const npmrcKeys = npmrc.split(/[\r\n]+/).map((line) => line.trim()).filter((line) => line !== '' && !/^[;#]/.test(line))
		.map((line) => line.split('=')[0].trim())
	assert.deepEqual(npmrcKeys.filter((key) => !/^[a-z0-9-]+$/.test(key) || !NPMRC_KEYS.includes(key)), [],
		`.npmrc may set only ${NPMRC_KEYS.join(', ')}, each spelled plainly`)
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
	// and no string in the file is "console". A string naming either one as a
	// command, a path or a module specifier therefore fails here unless it is
	// logged. Not looked at: a name assembled at run time from pieces, console
	// reached through a computed name (globalThis['cons' + 'ole']), a logged
	// object whose own inspect method runs code, and a launch made by a script
	// or npm script the harness runs.
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
		'no string in the e2e harness code may name vite or svelte-kit unless a console.* call is logging it, in a file that uses console only by calling its methods'
		+ (consoleOnlyCalled ? '' : ' (this file does not: it reaches console other than by calling a method on it, or holds the string "console")'))
})

test('the image is built by npm run build, and takes only that build from the build stage', QUICK, () => {
	const dockerfile = readRepoFile('Dockerfile')
	assert.doesNotMatch(dockerfile, PARSER_DIRECTIVE, 'the Dockerfile may not have a syntax, escape or check parser-directive line; dockerInstructions models none of them')
	// A SHELL instruction changes what runs every later RUN; NODE_OPTIONS or an
	// npm_config_* variable can change what npm run build runs; HOME, PREFIX
	// and DESTDIR move the config files npm reads; and ONBUILD carries any
	// instruction into every stage built FROM its own, past every rule here.
	// Refused in every stage: any SHELL and any ONBUILD; an ENV or ARG whose
	// text names NODE_OPTIONS or npm_config_*; and an ENV or ARG declaring a
	// name that is not a plain word of letters, digits and _, or is HOME,
	// PREFIX or DESTDIR. BuildKit drops quotes and backslashes from an ENV
	// name, so NODE_OPT"IONS" would set NODE_OPTIONS. Names are read from
	// dockerWords.
	const declaredNames = (instruction) => {
		const words = dockerWords(instruction.rest)
		if (instruction.keyword === 'ENV' && !words[0]?.includes('=')) return words.slice(0, 1)
		return words.filter((word) => instruction.keyword === 'ARG' || word.includes('=')).map((word) => word.split('=')[0])
	}
	const reshaping = dockerInstructions(dockerfile).filter((instruction) => ['SHELL', 'ONBUILD'].includes(instruction.keyword)
		|| (['ENV', 'ARG'].includes(instruction.keyword)
			&& (/\b(?:NODE_OPTIONS|npm_config_\w*)/i.test(instruction.rest)
				|| declaredNames(instruction).some((name) => !/^\w+$/.test(name) || /^(?:HOME|PREFIX|DESTDIR)$/i.test(name)))))
	assert.deepEqual(reshaping.map(spelled), [],
		'the Dockerfile may not have a SHELL or ONBUILD instruction, or an ENV or ARG naming NODE_OPTIONS or npm_config_*, declaring a name that is not a plain word, or setting HOME, PREFIX or DESTDIR')
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

	// npm reads config from the project's .npmrc, the user's ~/.npmrc, a
	// global npmrc under its prefix and its own builtin npmrc, and any of them
	// can give npm run build a preload or another script shell. In the build
	// stage and the stages it is built FROM, refused:
	// - any ADD; a COPY with a source that is not `.` or an existing file in
	//   the repo (a directory, a wildcard, a path in another stage, a missing
	//   file), or that names an npmrc other than the root .npmrc, which the
	//   first test vets; a COPY whose destination, resolved against its
	//   WORKDIR, is named npmrc or .npmrc; a COPY of `.` anywhere but the
	//   WORKDIR npm run build runs in; and a COPY that puts a file inside that
	//   WORKDIR anywhere but at the file's own path in the repo, so the tree
	//   npm run build sees there, its package.json and scripts/build.mjs
	//   included, is the repo's;
	// - a RUN flag holding a quote or a backslash, a --mount with an env= key,
	//   and a --mount whose target is a file named npmrc or .npmrc, or a
	//   directory holding one of those config files: /, /root, /home and the
	//   directories in it, /etc, /usr, /usr/local, /usr/local/etc,
	//   /usr/local/lib and npm's own directories under it, and the WORKDIR and
	//   its parents; and a --mount whose target is the WORKDIR npm run build
	//   runs in or anything inside it;
	// - a RUN, or a package.json script scriptsRunBy finds one running, whose
	//   text holds a quote, a backslash or a `$`, so every word in it is
	//   spelled out; that names npmrc, package.json, NODE_OPTIONS or
	//   npm_config_; or that has, after an npm word (npm, or a path ending in
	//   npm or npm-cli.js), a word in the same part of the command that is
	//   config or a prefix of it, set, pkg or edit.
	// npm run build reads the package.json in its WORKDIR, so that WORKDIR
	// must be one a COPY of `.` or of package.json put the repo's own
	// package.json in: a COPY of `.`, or of several sources or into a
	// destination ending in /, read as a directory.
	// Not looked at: a file a RUN writes without naming it (from a script the
	// RUN runs, say), and a program a mount or a COPY puts in place outside
	// the WORKDIR npm run build runs in. Paths are compared as written, so a
	// symlink a RUN makes is not followed.
	const stagesUpFrom = (stage) => {
		const stages = []
		for (let current = stage; current; current = current.parent) stages.push(current)
		return stages
	}
	const buildLineage = stagesUpFrom(build).flatMap((stage) => stage.instructions)
	// These flags preserve the source-to-destination placement read below.
	// --from is checked separately when the source files are inspected.
	const unknownCopyFlags = buildLineage.filter((instruction) => instruction.keyword === 'COPY'
		&& instruction.flags.some((flag) => !/^(?:--(?:chown|chmod|from)=\S+|--link(?:=(?:true|false))?)$/.test(flag)))
	assert.deepEqual(unknownCopyFlags.map(spelled), [],
		'COPY in the build stage lineage may use only --chown=, --chmod=, --from= and --link (optionally =true or =false); other flags are not modelled')
	const repoFile = (path) => {
		try {
			return statSync(new URL(`../../${path}`, import.meta.url)).isFile()
		} catch {
			return false
		}
	}
	const npmrcName = (path) => /(?:^|\/)\.?npmrc$/i.test(path)
	const copySources = (instruction) => dockerArgs(instruction).slice(0, -1)
	const copyDestination = (instruction) => tidyPath(posix.resolve(instruction.workdir, dockerArgs(instruction).at(-1)))
	// A COPY whose destination is a directory: several sources, `.`, or a
	// destination ending in /. Otherwise its one source lands at that name.
	const intoDirectory = (instruction) => copySources(instruction).length > 1
		|| dockerArgs(instruction).at(-1).endsWith('/') || ['.', ''].includes(tidyPath(copySources(instruction)[0] ?? '').replace(/^\/+/, ''))
	const buildDir = tidyPath(lastRun.workdir)
	const inBuildDir = (path) => path === buildDir || path.startsWith(`${buildDir}/`)
	// Where a COPY puts a source: under the destination by its own name, or
	// at the destination itself when that is a file.
	const landsAt = (instruction, path) => intoDirectory(instruction)
		? tidyPath(posix.join(copyDestination(instruction), posix.basename(path)))
		: copyDestination(instruction)
	const looseCopies = buildLineage.filter((instruction) => instruction.keyword === 'ADD'
		|| (instruction.keyword === 'COPY' && (npmrcName(copyDestination(instruction)) || copySources(instruction).some((source) => {
			const path = tidyPath(source).replace(/^\/+/, '')
			if (path === '.' || path === '') return copyDestination(instruction) !== buildDir
			if (instruction.flags.some((flag) => /^--from=/i.test(flag)) || /[*?[\\]/.test(source) || source.endsWith('/') || !repoFile(path)) return true
			const target = landsAt(instruction, path)
			if (inBuildDir(target) && target !== `${buildDir}/${path}`) return true
			return npmrcName(path) && path !== '.npmrc'
		}))))
	const holdsConfig = (target, workdir) => {
		const path = tidyPath(posix.resolve(workdir, target))
		const parents = (dir) => dir.split('/').map((_, i, parts) => parts.slice(0, i + 1).join('/') || '/')
		return npmrcName(path)
			|| ['/', '/root', '/home', '/etc', '/usr', '/usr/local', '/usr/local/etc', '/usr/local/lib', '/usr/local/lib/node_modules', '/usr/local/lib/node_modules/npm'].includes(path)
			|| /^\/home\/[^/]+$/.test(path)
			|| parents(workdir).includes(path)
	}
	const mountTargets = (flag) => flag.slice('--mount='.length).split(',')
		.filter((pair) => /^(?:target|dst|destination)=/i.test(pair)).map((pair) => pair.split('=').slice(1).join('='))
	const looseFlags = buildLineage.filter((instruction) => instruction.keyword === 'RUN' && instruction.flags.some((flag) => /["'\\]/.test(flag)
		|| (/^--mount=/i.test(flag) && (flag.split(',').some((pair) => /^(?:--mount=)?env=/i.test(pair))
			|| mountTargets(flag).some((target) => holdsConfig(target, instruction.workdir)
				|| inBuildDir(tidyPath(posix.resolve(instruction.workdir, target))))))))
	const CONFIG_WORD = /^(?:c|co|con|conf|confi|config|set|pkg|edit)$/i
	const configWriters = buildLineage.filter((instruction) => instruction.keyword === 'RUN')
		.flatMap((run) => commandsReachedBy(run, scripts))
		.filter(([, command]) => /["'\\$]/.test(command) || /npmrc|package\.json|NODE_OPTIONS|npm_config_/i.test(command)
			|| command.split(/&&|\|\||[;|\n]/).some((part) => {
				const words = part.trim().split(/\s+/).map((word) => word.replace(/^[("']+|[)"']+$/g, ''))
				const npm = words.findIndex((word) => /^(?:.*\/)?npm(?:-cli\.js)?(?:@\S*)?$/.test(word))
				return npm >= 0 && words.slice(npm + 1).some((word) => CONFIG_WORD.test(word))
			}))
		.map(([where, command]) => `${where}: ${command}`)
	assert.deepEqual([...looseCopies.map(spelled), ...looseFlags.map(spelled), ...configWriters], [],
		'in the build stage and the stages it is built FROM: no ADD; no COPY of anything but . into the build WORKDIR or existing repo files (the root .npmrc the only npmrc), none onto an npmrc, and none putting a file in the build WORKDIR anywhere but its own repo path; no RUN flag with a quote or backslash, no --mount with env=, onto an npm config location or into the build WORKDIR; and no RUN or script it reaches with a quote, backslash or $, or that runs npm config, set, pkg or edit or names npmrc, package.json, NODE_OPTIONS or npm_config_')
	const manifestDirs = buildLineage.filter((instruction) => instruction.keyword === 'COPY'
		&& copySources(instruction).some((source) => ['.', 'package.json'].includes(tidyPath(source).replace(/^\/+/, ''))) && intoDirectory(instruction))
		.map(copyDestination)
	assert.ok(manifestDirs.includes(tidyPath(lastRun.workdir)),
		`npm run build must run in a WORKDIR a COPY put the repo's package.json in (${manifestDirs.join(', ') || 'none'}), not ${lastRun.workdir}`)

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
	// context's top-level build directory, which .dockerignore must leave out
	// by assertContextLeavesOut's rule.
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
	assertContextLeavesOut('build')
})

test('the Docker build context leaves out the e2e harness\'s per-run builds', QUICK, () => {
	// Each e2e harness run builds into build-runs/ in this checkout and tries to
	// remove that build when it ends; the next run sweeps the builds of runs
	// that were killed. What build-runs/ holds is therefore the builds of runs
	// still going, of runs whose build could not be removed or that were killed
	// and not yet swept, and anything put there by hand. In the context, a
	// docker build sends those to the daemon, and the build stage's COPY . .
	// puts them next to the source the image's own build reads.
	assertContextLeavesOut('build-runs')
})

test('every evaluation of the config under one pinned build agrees on version.name', QUICK, async () => {
	assert.deepEqual(await versionsUnder('pinned-for-this-test'), ['pinned-for-this-test', 'pinned-for-this-test'])
})

test('scripts/build.mjs hands vite a pinned version, and the config reads exactly that version', QUICK, async () => {
	// The half the config test above cannot see: that the build actually
	// produces the pin and passes it to the process that evaluates the config.
	// An environment without it falls back to Date.now() per evaluation, which
	// is the failure this pin exists to prevent. Driven through the real entry
	// point, so the defaults it relies on are the ones under test. Of the lock,
	// what is checked is that its file holds this build's pid while vite runs
	// and when it exits; that a second build waits for it is not.
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

test('a build whose two halves carry different version hashes fails, naming both', QUICK, () => {
	// What a writer outside the lock leaves: vite exits 0, and the server
	// defines a hydration global the client never reads.
	const run = runBuildScript({ SRD_TEST_SERVER_HASH: 'devside1', SRD_TEST_CLIENT_HASH: 'pinned1' })
	assert.equal(run.spawns.length, 1, 'one build invocation must start exactly one process or worker, the vite build')
	assert.deepEqual(run.exits, [{ exited: 0, locked: true }])
	assert.equal(run.status, 1, 'scripts/build.mjs must fail a build whose halves disagree')
	assert.match(run.stderr, /^build check failed: the server defines its hydration payload as __sveltekit_devside1, but the client reads __sveltekit_pinned1,/m)
})

test('a build under a version the operator supplied is checked as well', QUICK, () => {
	// The operator's version replaces only the pin; the halves can still
	// disagree, and the check must still run.
	const run = runBuildScript({ SRD_BUILD_VERSION: 'release-7', SRD_TEST_SERVER_HASH: 'devside1', SRD_TEST_CLIENT_HASH: 'pinned1' })
	assert.equal(run.status, 1, 'scripts/build.mjs must fail a build whose halves disagree, whatever version it ran under')
	assert.match(run.stderr, /^build check failed: the server defines its hydration payload as __sveltekit_devside1, but the client reads __sveltekit_pinned1,/m)
})

test('a build in which the check finds no version hash fails', QUICK, () => {
	const run = runBuildScript({ SRD_TEST_NO_OUTPUT: '1' })
	assert.equal(run.status, 1, 'scripts/build.mjs must fail a build the check found nothing in')
	assert.match(run.stderr, /^build check failed: no version_hash: "<hash>" found in the \.js files under /m)
	assert.match(run.stderr, namedUnder(run, 'build', 'server'))
})

test('the build check reads the directory BUILD_OUT_DIR names', QUICK, () => {
	const named = join('build-runs', 'one')
	assert.equal(runBuildScript({ BUILD_OUT_DIR: named }).status, 0, 'halves that agree, written where BUILD_OUT_DIR says, must pass')
	const elsewhere = runBuildScript({ BUILD_OUT_DIR: named, SRD_TEST_OUTPUT_DIR: 'build' })
	assert.equal(elsewhere.status, 1, 'halves written outside BUILD_OUT_DIR must not count')
	assert.match(elsewhere.stderr, namedUnder(elsewhere, 'build-runs', 'one', 'server'))
})

test('the build check reads the build output while the build lock is held', QUICK, () => {
	// A build waiting on the lock clears and rewrites the same output directory
	// once it holds it, so a check made after the release can read that build's
	// files. What is checked: the check listed both halves and read a file in
	// each, and every recorded path equal to build or starting with build/
	// (or build followed by a backslash) after path.resolve and path.relative
	// from the run's working directory was read while the lock file held the
	// build's pid. Not looked at: reads made through anything but
	// fs.readdirSync and fs.readFileSync on a path
	// (a file descriptor, another fs function), and a path spelled in other
	// letter case on a file system that ignores case. Namespaced and UNC paths
	// that remain absolute after path.relative do not enter the build/ filter.
	const run = runBuildScript({})
	assert.equal(run.status, 0, `build script failed: ${run.stderr}`)
	const pathOf = (read) => read.readdir ?? read.readFile
	const reads = run.reads.filter((read) => /^build(?:[\\/]|$)/.test(pathOf(read)))
	for (const half of ['server', 'client']) {
		assert.ok(reads.some((read) => read.readdir === join('build', half)), `the check must list build/${half}`)
		assert.ok(reads.some((read) => read.readFile?.startsWith(join('build', half, 'x').slice(0, -1))),
			`the check must read a file under build/${half}`)
	}
	assert.deepEqual(reads.filter((read) => !read.locked).map(pathOf), [],
		'every read of the build output must happen while the build lock is held')
})

test('the build check reads every .js file under each half and nothing else', QUICK, () => {
	// Kit puts the version hash in the server's index.js and in whichever
	// client chunk reads the payload. Written here: agreeing hashes in nested
	// .js files, and a different hash in a source map and in a non-.js file,
	// which the check must not read; the server half also carries the
	// __sveltekit_ spellings a real server does, which are not client hashes.
	// Each step after the first changes one thing from a passing tree.
	const dir = mkdtempSync(join(tmpdir(), 'srd-build-output-'))
	try {
		const write = (path, text) => {
			mkdirSync(join(dir, path, '..'), { recursive: true })
			writeFileSync(join(dir, path), text)
		}
		write('server/chunks/internal.js', 'export const options = {\n  version_hash: "abc123"\n}\n'
			+ 'const sw = globalThis.__sveltekit_sw\nconst prefix = "__sveltekit_$"\n')
		write('server/chunks/internal.js.map', '{"sourcesContent":["version_hash: \\"zzz999\\""]}')
		write('client/_app/immutable/chunks/a.js', 'globalThis.__sveltekit_abc123?.base')
		write('client/_app/immutable/chunks/a.js.map', '{"sourcesContent":["globalThis.__sveltekit_zzz999"]}')
		write('client/_app/version.json', '{"__sveltekit_zzz999":1}')
		assert.equal(versionHashMismatch(dir), null)
		write('client/_app/immutable/nodes/b.js', 'globalThis.__sveltekit_def456.data')
		assert.match(versionHashMismatch(dir) ?? '', /but the client reads __sveltekit_abc123 and __sveltekit_def456,/,
			'a second client hash in a nested chunk must be found')
		rmSync(join(dir, 'client/_app/immutable/nodes/b.js'))
		// The service worker global kit writes into a client with explicit
		// environment variables, and its dev flag, are not hashes.
		write('client/service-worker.js', 'const env = globalThis.__sveltekit_sw.env\nif (globalThis.__sveltekit_dev) {}\n')
		assert.equal(versionHashMismatch(dir), null, '__sveltekit_sw and __sveltekit_dev in the client must not count as hashes')
		write('server/index.js', 'const options = { version_hash: "def456" }')
		assert.match(versionHashMismatch(dir) ?? '', /carries more than one version_hash \(abc123, def456\)/)
		rmSync(join(dir, 'server/index.js'))
		rmSync(join(dir, 'client'), { recursive: true })
		assert.match(versionHashMismatch(dir) ?? '', /^no __sveltekit_<hash> found in the \.js files under .*client:/)
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
})

test('a version hash spelled like one of kit\'s other names still counts as a hash', QUICK, () => {
	// Kit's hash is base 36, so it can be all letters, begin with the names
	// the check skips, or both. What is checked, for one hash of each shape:
	// halves that carry it agree, and a client reading a second hash beside it
	// is reported with both.
	for (const hash of ['kqzxwv', 'swk2a9', 'dev3kq', 'swahkg', 'devqzx']) {
		const dir = mkdtempSync(join(tmpdir(), 'srd-build-hash-'))
		try {
			mkdirSync(join(dir, 'server'), { recursive: true })
			mkdirSync(join(dir, 'client'), { recursive: true })
			writeFileSync(join(dir, 'server', 'index.js'), `const options = { version_hash: "${hash}" }`)
			writeFileSync(join(dir, 'client', 'start.js'), `globalThis.__sveltekit_${hash}?.base`)
			assert.equal(versionHashMismatch(dir), null, `halves agreeing on ${hash} must pass`)
			writeFileSync(join(dir, 'client', 'other.js'), 'globalThis.__sveltekit_zz9')
			assert.match(versionHashMismatch(dir) ?? '', new RegExp(`but the client reads __sveltekit_${hash} and __sveltekit_zz9,`),
				`${hash} must be counted among the client's hashes`)
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	}
})

// The `out` the adapter kit will use takes from svelte.config.js, evaluated in
// a child process under the environment a build gives vite for `env`
// (buildEnvironment over the parent's environment with BUILD_OUT_DIR removed,
// NODE_ENV defaulted to production when empty or unset, npm_lifecycle_event
// set to build). Before importing the config, the probe sets argv to node,
// the vite.js path and build, and clears execArgv, as scripts/vite-build.mjs
// launches node without options. It still uses an import hook, with
// svelte-adapter-uws resolved to a stub that reads `out` when it is called and
// defaults it as the real adapter does. The real adapter keeps it to itself.
function adapterOutUnder(env) {
	const dir = mkdtempSync(join(tmpdir(), 'srd-adapter-out-'))
	try {
		const stub = join(dir, 'stub-adapter.mjs')
		const hooks = join(dir, 'hooks.mjs')
		const register = join(dir, 'register.mjs')
		writeFileSync(stub, 'export default (opts = {}) => {\n\tconst { out = \'build\' } = opts\n\treturn { name: \'stub-adapter\', out }\n}\n')
		writeFileSync(hooks, 'export async function resolve(specifier, context, next) {\n'
			+ `\tif (specifier === 'svelte-adapter-uws') return { url: ${JSON.stringify(pathToFileURL(stub).href)}, shortCircuit: true }\n`
			+ '\treturn next(specifier, context)\n}\n')
		writeFileSync(register, `import { register } from 'node:module'\nregister(${JSON.stringify(pathToFileURL(hooks).href)})\n`)
		const parentEnv = { ...process.env }
		delete parentEnv.BUILD_OUT_DIR
		const probe = `process.argv = [process.execPath, ${JSON.stringify(fileURLToPath(new URL('../../node_modules/vite/bin/vite.js', import.meta.url)))}, 'build']\n`
			+ 'process.execArgv.length = 0\n'
			+ `const config = (await import(${JSON.stringify(configHref)})).default\n`
			+ 'console.log(JSON.stringify({ stub: config.kit.adapter?.name === \'stub-adapter\', out: config.kit.adapter?.out ?? null }))'
		/** @type {NodeJS.ProcessEnv} */
		const childEnv = buildEnvironment({ ...parentEnv, ...env, npm_lifecycle_event: 'build' })
		childEnv.NODE_ENV ||= 'production'
		const result = spawnSync(process.execPath, ['--import', pathToFileURL(register).href, '--input-type=module', '-e', probe], {
			env: childEnv,
			encoding: 'utf8',
			timeout: 20_000
		})
		assert.equal(result.status, 0, `evaluating svelte.config.js failed: ${result.stderr}`)
		const seen = JSON.parse(result.stdout.trim().split('\n').at(-1))
		assert.ok(seen.stub, 'svelte-adapter-uws must resolve to the stub, or the adapter\'s options cannot be read')
		return seen.out
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
}

test('svelte.config.js hands the adapter the directory buildOutDir names', QUICK, () => {
	// The check is only worth anything on the directory the adapter wrote.
	// What is checked: with BUILD_OUT_DIR unset, empty and set, the config,
	// evaluated as adapterOutUnder describes, calls the adapter kit then uses
	// with an `out`, or the adapter's default when omitted, equal to what
	// buildOutDir names for the same environment.
	// A config that computes the same directory without buildOutDir passes.
	// Not looked at: options given to sveltekit() in vite.config.js, which
	// replace svelte.config.js; anything else a real build sets that the
	// config could read (other npm variables or the importer's identity); and
	// a config importing a named export of svelte-adapter-uws, which the stub
	// does not have (the test then fails on the import).
	for (const env of [{}, { BUILD_OUT_DIR: '' }, { BUILD_OUT_DIR: join('build-runs', 'x') }]) {
		assert.equal(adapterOutUnder(env), buildOutDir(env), `under ${JSON.stringify(env)} the adapter must write where the check reads`)
	}
	assert.equal(buildOutDir({}), 'build')
	assert.equal(buildOutDir({ BUILD_OUT_DIR: '' }), 'build')
	assert.equal(buildOutDir({ BUILD_OUT_DIR: 'build-runs/x' }), 'build-runs/x')
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
