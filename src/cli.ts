#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { Bws } from './bws.js';
import { readClipboard, writeClipboard } from './clipboard.js';
import { loadConfig, saveConfig, type Config } from './config.js';
import { parseEnvFlag, parseEnvTemplate } from './envfile.js';
import { parseRef, resolveRefs, toRef } from './refs.js';
import { runChild } from './run.js';
import { clearToken, readToken, requireToken, writeToken } from './token.js';
import { exec, readStdin, trimOneNewline, UserError } from './util.js';

const HELP = `2warden — Bitwarden Secrets Manager for coding agents.
The agent works with references (bws://<id>). It never needs the values.

Find and use
  2warden find <query...> [--project P] [--json]   Find secrets by key. Prints references, never values.
  2warden projects [--json]                        List projects this token can see.
  2warden run --env NAME=bws://<id> ... [--no-mask] -- <cmd> [args]
                                                   Run a command with secrets as env vars.
  2warden env run <file> [--no-mask] -- <cmd> [args]
                                                   Same, with NAME=bws://<id> lines from a template file.
  2warden env check <file>                         Check that every reference in a template resolves.

Save
  2warden create <KEY> (--clipboard | --stdin) [--project P] [--note TEXT] [--allow-duplicate]
                                                   Save a new secret. The value comes from the clipboard
                                                   or a pipe, never from an argument. Read back and checked.

Reveal (avoid in agent sessions)
  2warden read <bws://id> [--clipboard]            Print one value, or copy it to the clipboard.

Setup
  2warden token set (--clipboard | --stdin)        Store the machine-account access token.
  2warden token status | token clear
  2warden config set project <name-or-id>          Default project for create.
  2warden config set server <url>                  e.g. https://vault.bitwarden.eu
  2warden config show
  2warden doctor                                   Check that everything is wired up.

Output from run / env run is masked by default: injected values become ***.
`;

interface Args {
	pos: string[];
	flags: Map<string, string[]>;
	/** Everything after `--`. */
	rest: string[];
}

function parseArgs(argv: string[], valueFlags: string[] = [], boolFlags: string[] = []): Args {
	const a: Args = { pos: [], flags: new Map(), rest: [] };
	for (let i = 0; i < argv.length; i++) {
		const t = argv[i]!;
		if (t === '--') {
			a.rest = argv.slice(i + 1);
			break;
		}
		if (t.startsWith('--')) {
			const [name, inline] = t.slice(2).split(/=(.*)/s, 2) as [string, string | undefined];
			if (valueFlags.includes(name)) {
				const v = inline ?? argv[++i];
				if (v === undefined) throw new UserError(`--${name} needs a value.`, 2);
				a.flags.set(name, [...(a.flags.get(name) ?? []), v]);
			} else if (boolFlags.includes(name) && inline === undefined) {
				a.flags.set(name, ['true']);
			} else {
				throw new UserError(`Unknown option --${name}. Run 2warden --help.`, 2);
			}
		} else {
			a.pos.push(t);
		}
	}
	return a;
}

const has = (a: Args, f: string) => a.flags.has(f);
const one = (a: Args, f: string) => a.flags.get(f)?.at(-1);

async function client(cfg?: Config): Promise<Bws> {
	const c = cfg ?? (await loadConfig());
	return new Bws(await requireToken(), c.server ?? process.env.BWS_SERVER_URL);
}

/** Read a new secret value from the clipboard or stdin. Never from argv. */
async function readNewValue(a: Args): Promise<string> {
	const clip = has(a, 'clipboard');
	const stdin = has(a, 'stdin');
	if (clip === stdin) throw new UserError('Use exactly one of --clipboard or --stdin.', 2);
	const v = trimOneNewline(clip ? await readClipboard() : await readStdin());
	if (!v) throw new UserError(clip ? 'The clipboard is empty.' : 'Nothing came in on stdin.');
	return v;
}

const norm = (s: string) => s.toLowerCase().replace(/[\s_\-.]+/g, '');

// ---------------------------------------------------------------- commands

async function cmdFind(argv: string[]): Promise<void> {
	const a = parseArgs(argv, ['project'], ['json']);
	const bws = await client();
	const projectArg = one(a, 'project');
	const project = projectArg ? await bws.resolveProject(projectArg) : undefined;
	const [secrets, projects] = await Promise.all([bws.listSecrets(project?.id), bws.listProjects()]);
	const pname = new Map(projects.map((p) => [p.id, p.name]));
	const queries = a.pos.map(norm).filter(Boolean);
	// Match on keys only. Notes and values are never searched, so `find` cannot be used to probe them.
	const hits = secrets
		.filter((s) => queries.length === 0 || queries.some((q) => norm(s.key).includes(q)))
		.map((s) => ({
			key: s.key,
			ref: toRef(s.id),
			project: (s.projectId && pname.get(s.projectId)) ?? null
		}))
		.sort((x, y) => x.key.localeCompare(y.key));

	if (has(a, 'json')) {
		console.log(JSON.stringify(hits, null, 2));
		return;
	}
	if (hits.length === 0) {
		console.log(queries.length ? `No secret keys match: ${a.pos.join(', ')}` : 'No secrets visible to this token.');
		return;
	}
	const w = Math.max(...hits.map((h) => h.key.length));
	for (const h of hits) console.log(`${h.key.padEnd(w)}  ${h.ref}  ${h.project ?? ''}`.trimEnd());
}

async function cmdProjects(argv: string[]): Promise<void> {
	const a = parseArgs(argv, [], ['json']);
	const projects = await (await client()).listProjects();
	if (has(a, 'json')) console.log(JSON.stringify(projects.map(({ id, name }) => ({ id, name })), null, 2));
	else for (const p of projects) console.log(`${p.name}  ${p.id}`);
}

async function runWith(entries: { name: string; ref?: string; value?: string }[], cmd: string[], mask: boolean) {
	if (cmd.length === 0) throw new UserError('Missing command after --.', 2);
	const refs = entries.flatMap((e) => (e.ref ? [e.ref] : []));
	const resolved = refs.length ? await resolveRefs(await client(), refs) : new Map();
	const inject: Record<string, string> = {};
	const secretValues: string[] = [];
	for (const e of entries) {
		if (e.ref) {
			const v = resolved.get(parseRef(e.ref))!.value;
			inject[e.name] = v;
			secretValues.push(v);
		} else {
			inject[e.name] = e.value ?? '';
		}
	}
	// Mask only values that came from Bitwarden, not plain template values like NODE_ENV=development.
	return runChild(cmd, inject, mask ? secretValues : null);
}

async function cmdRun(argv: string[]): Promise<number> {
	const a = parseArgs(argv, ['env'], ['no-mask']);
	if (a.pos.length) throw new UserError(`Put the command after --, e.g. 2warden run --env ... -- ${a.pos.join(' ')}`, 2);
	const entries = (a.flags.get('env') ?? []).map(parseEnvFlag);
	if (entries.length === 0) throw new UserError('Give at least one --env NAME=bws://<id>.', 2);
	return runWith(entries, a.rest, !has(a, 'no-mask'));
}

async function loadTemplate(path: string | undefined) {
	if (!path) throw new UserError('Give the template file, e.g. .env.tpl', 2);
	let text: string;
	try {
		text = await readFile(path, 'utf8');
	} catch {
		throw new UserError(`Cannot read ${path}.`);
	}
	return parseEnvTemplate(text);
}

async function cmdEnv(argv: string[]): Promise<number> {
	const [sub, ...restArgv] = argv;
	if (sub === 'run') {
		const a = parseArgs(restArgv, [], ['no-mask']);
		const entries = await loadTemplate(a.pos[0]);
		return runWith(entries, a.rest, !has(a, 'no-mask'));
	}
	if (sub === 'check') {
		const a = parseArgs(restArgv);
		const entries = await loadTemplate(a.pos[0]);
		const refs = entries.filter((e) => e.ref);
		const resolved = refs.length ? await resolveRefs(await client(), refs.map((e) => e.ref!)) : new Map();
		for (const e of entries) {
			if (e.ref) console.log(`ok     ${e.name} -> ${resolved.get(parseRef(e.ref))!.key}`);
			else console.log(`plain  ${e.name}`);
		}
		return 0;
	}
	throw new UserError('Usage: 2warden env run <file> -- <cmd>  |  2warden env check <file>', 2);
}

async function cmdRead(argv: string[]): Promise<void> {
	const a = parseArgs(argv, [], ['clipboard']);
	if (a.pos.length !== 1) throw new UserError('Usage: 2warden read <bws://id> [--clipboard]', 2);
	const id = parseRef(a.pos[0]!);
	const s = (await resolveRefs(await client(), [a.pos[0]!])).get(id)!;
	if (has(a, 'clipboard')) {
		await writeClipboard(s.value);
		console.error(`Copied ${s.key} to the clipboard.`);
	} else {
		if (process.stdout.isTTY === false) console.error(`2warden: printing the value of ${s.key}.`);
		process.stdout.write(s.value + '\n');
	}
}

async function cmdCreate(argv: string[]): Promise<void> {
	const a = parseArgs(argv, ['project', 'note'], ['clipboard', 'stdin', 'allow-duplicate']);
	if (a.pos.length !== 1) {
		throw new UserError('Usage: 2warden create <KEY> (--clipboard | --stdin) [--project P] [--note TEXT]', 2);
	}
	const key = a.pos[0]!;
	if (/\s/.test(key)) throw new UserError('Keys cannot contain spaces. Use NAMES_LIKE_THIS.', 2);
	const cfg = await loadConfig();
	const projectArg = one(a, 'project') ?? cfg.project;
	if (!projectArg) throw new UserError('No project. Pass --project, or set one: 2warden config set project <name>', 2);

	const value = await readNewValue(a);
	const bws = await client(cfg);
	const project = await bws.resolveProject(projectArg);

	if (!has(a, 'allow-duplicate')) {
		const existing = (await bws.listSecrets(project.id)).filter((s) => s.key === key);
		if (existing.length) {
			throw new UserError(
				`"${key}" already exists in ${project.name}: ${existing.map((s) => toRef(s.id)).join(', ')}\n` +
					'Use that reference, or pass --allow-duplicate.'
			);
		}
	}

	// One attempt. Writes are never retried: a retry after a timeout can create a second copy.
	const created = await bws.createSecret(key, value, project.id, one(a, 'note'));
	const back = await bws.getSecret(created.id);
	if (back.value !== value || back.key !== key) {
		throw new UserError(`Saved ${toRef(created.id)}, but reading it back did not match. Check it in Bitwarden.`);
	}
	console.log(toRef(created.id));
	console.error(`Saved ${key} in ${project.name}. Read back and checked.`);
}

async function cmdToken(argv: string[]): Promise<void> {
	const [sub, ...restArgv] = argv;
	if (sub === 'set') {
		const a = parseArgs(restArgv, [], ['clipboard', 'stdin']);
		const where = await writeToken(await readNewValue(a));
		console.log(`Token saved (${where}).`);
		if (has(a, 'clipboard')) console.log('Tip: copy something else now, so the token does not stay in the clipboard.');
		return;
	}
	if (sub === 'status') {
		const t = await readToken();
		console.log(t ? `Token found (${t.source}).` : 'No token.');
		if (t?.source === 'env') console.log('Warning: BWS_ACCESS_TOKEN is set in the environment. Anything the agent runs can read it.');
		return;
	}
	if (sub === 'clear') {
		await clearToken();
		console.log('Token removed.');
		return;
	}
	throw new UserError('Usage: 2warden token set (--clipboard | --stdin) | token status | token clear', 2);
}

async function cmdConfig(argv: string[]): Promise<void> {
	const cfg = await loadConfig();
	if (argv[0] === 'show' || argv.length === 0) {
		console.log(JSON.stringify(cfg, null, 2));
		return;
	}
	if (argv[0] === 'set' && argv.length === 3) {
		const [, k, v] = argv as [string, string, string];
		if (k === 'project') cfg.project = v;
		else if (k === 'server') cfg.server = v;
		else throw new UserError(`Unknown setting "${k}". Use project or server.`, 2);
		await saveConfig(cfg);
		console.log(`Set ${k}.`);
		return;
	}
	throw new UserError('Usage: 2warden config set (project|server) <value> | config show', 2);
}

async function cmdDoctor(): Promise<number> {
	let ok = true;
	const line = (good: boolean, msg: string) => {
		if (!good) ok = false;
		console.log(`${good ? 'ok  ' : 'FAIL'}  ${msg}`);
	};
	try {
		const r = await exec(process.env.TWOWARDEN_BWS_BIN ?? 'bws', ['--version']);
		line(r.code === 0, `bws installed: ${r.stdout.trim()}`);
	} catch {
		line(false, 'bws is not installed (brew install bitwarden/tap/bws)');
	}
	const t = await readToken();
	line(!!t, t ? `access token found (${t.source})` : 'no access token (2warden token set --clipboard)');
	if (t?.source === 'env') console.log('      note: env token is visible to everything the agent runs');
	const cfg = await loadConfig();
	if (t) {
		try {
			const projects = await new Bws(t.token, cfg.server ?? process.env.BWS_SERVER_URL).listProjects();
			line(true, `token works, sees ${projects.length} project(s): ${projects.map((p) => p.name).join(', ')}`);
		} catch (e) {
			line(false, `token does not work: ${(e as Error).message}`);
		}
	}
	console.log(`info  default project: ${cfg.project ?? '(none)'}; server: ${cfg.server ?? 'default (US cloud)'}`);
	return ok ? 0 : 1;
}

// ---------------------------------------------------------------- main

async function main(argv: string[]): Promise<number> {
	const [cmd, ...rest] = argv;
	switch (cmd) {
		case undefined:
		case '-h':
		case '--help':
		case 'help':
			process.stdout.write(HELP);
			return 0;
		case '--version':
			console.log('0.1.0');
			return 0;
		case 'find':
			await cmdFind(rest);
			return 0;
		case 'projects':
			await cmdProjects(rest);
			return 0;
		case 'run':
			return cmdRun(rest);
		case 'env':
			return cmdEnv(rest);
		case 'read':
			await cmdRead(rest);
			return 0;
		case 'create':
			await cmdCreate(rest);
			return 0;
		case 'token':
			await cmdToken(rest);
			return 0;
		case 'config':
			await cmdConfig(rest);
			return 0;
		case 'doctor':
			return cmdDoctor();
		default:
			throw new UserError(`Unknown command "${cmd}". Run 2warden --help.`, 2);
	}
}

main(process.argv.slice(2)).then(
	(code) => {
		process.exitCode = code;
	},
	(e: unknown) => {
		if (e instanceof UserError) {
			process.stderr.write(`2warden: ${e.message}\n`);
			process.exitCode = e.exitCode;
		} else {
			// Unexpected: print the message only. A stack could carry argv, and argv can hold a value in bws calls.
			process.stderr.write(`2warden: unexpected error: ${(e as Error)?.message ?? String(e)}\n`);
			process.exitCode = 1;
		}
	}
);
