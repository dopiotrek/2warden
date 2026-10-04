import { access, readFile, writeFile } from 'node:fs/promises';
import type { Bws, Project } from './bws.js';
import { parseEnvTemplate } from './envfile.js';
import { toRef } from './refs.js';
import { UserError } from './util.js';

// Pick keys that hold secrets. Public-by-design and platform keys are skipped.
const SECRET_RE = /(KEY|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE|CREDENTIAL|DATABASE_URL|DIRECT_URL|DSN)/;
const SKIP_RE = /^(PUBLIC_|VITE_|NEXT_PUBLIC_|VERCEL|TURBO_|NX_)/;

export function looksSecret(name: string): boolean {
	return SECRET_RE.test(name) && !SKIP_RE.test(name);
}

export interface ImportOptions {
	file: string;
	project: Project;
	prefix: string;
	only?: string[];
	out: string;
	dryRun: boolean;
	force: boolean;
}

export interface ImportRow {
	name: string;
	key: string;
	status: 'new' | 'exists' | 'exists-differs' | 'created' | 'failed';
	ref?: string;
}

/**
 * Copy secrets from a .env file into Bitwarden and write a template of references.
 * Values are read here and handed to bws only. They are never printed.
 */
export async function importEnv(bws: Bws, o: ImportOptions, log: (s: string) => void): Promise<ImportRow[]> {
	let text: string;
	try {
		text = await readFile(o.file, 'utf8');
	} catch {
		throw new UserError(`Cannot read ${o.file}.`);
	}
	// Later lines win, like dotenv.
	const values = new Map<string, string>();
	for (const e of parseEnvTemplate(text)) if (e.value !== undefined) values.set(e.name, e.value);

	let names: string[];
	if (o.only) {
		const missing = o.only.filter((n) => !values.has(n));
		if (missing.length) throw new UserError(`Not in ${o.file}: ${missing.join(', ')}`);
		names = o.only;
	} else {
		names = [...values.keys()].filter(looksSecret);
	}
	names = names.filter((n) => (values.get(n) ?? '') !== '');
	if (names.length === 0) throw new UserError('Nothing to import: no secret-looking keys with a value.');

	if (!o.dryRun && !o.force) {
		const exists = await access(o.out).then(
			() => true,
			() => false
		);
		if (exists) throw new UserError(`${o.out} already exists. Pass --force to replace it, or --out <file>.`);
	}

	const existing = await bws.listSecrets(o.project.id);
	const byKey = new Map(existing.map((s) => [s.key, s]));
	const rows: ImportRow[] = names.map((name) => {
		const key = o.prefix + name;
		const s = byKey.get(key);
		if (!s) return { name, key, status: 'new' };
		return { name, key, status: s.value === values.get(name) ? 'exists' : 'exists-differs', ref: toRef(s.id) };
	});

	if (o.dryRun) return rows;

	// One attempt per key, never retried. A failure stops the run; what was saved stays saved.
	for (const r of rows) {
		if (r.status !== 'new') continue;
		const value = values.get(r.name)!;
		try {
			const created = await bws.createSecret(r.key, value, o.project.id, `imported from ${o.file}`);
			const back = await bws.getSecret(created.id);
			if (back.value !== value) throw new UserError(`${r.key}: read back did not match.`);
			r.status = 'created';
			r.ref = toRef(created.id);
		} catch (e) {
			r.status = 'failed';
			log(`${r.key} failed: ${(e as Error).message}`);
			break;
		}
	}

	const ok = rows.filter((r) => r.ref);
	const tpl =
		`# 2warden template: references only, no values. Safe to commit.\n` +
		`# Made by \`2warden import ${o.file}\`. Use: 2warden env run ${o.out} -- <command>\n` +
		ok.map((r) => `${r.name}=${r.ref}`).join('\n') +
		'\n';
	await writeFile(o.out, tpl);
	return rows;
}
