import { isRef } from './refs.js';
import { UserError } from './util.js';

export interface EnvEntry {
	name: string;
	/** A bws:// reference, resolved at run time. */
	ref?: string;
	/** A plain value, used as written. */
	value?: string;
	line: number;
}

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Parse a .env template. Lines look like a normal .env file:
 *   OPENAI_API_KEY=bws://3f2a...
 *   PORT=3000
 *   # comments and blank lines are fine; `export ` prefix is fine
 */
export function parseEnvTemplate(text: string): EnvEntry[] {
	const out: EnvEntry[] = [];
	text.split(/\r?\n/).forEach((raw, idx) => {
		const lineNo = idx + 1;
		let line = raw.trim();
		if (!line || line.startsWith('#')) return;
		if (line.startsWith('export ')) line = line.slice(7).trim();
		const eq = line.indexOf('=');
		if (eq <= 0) throw new UserError(`Line ${lineNo}: expected NAME=value.`);
		const name = line.slice(0, eq).trim();
		if (!NAME_RE.test(name)) throw new UserError(`Line ${lineNo}: "${name}" is not a valid variable name.`);
		let value = line.slice(eq + 1).trim();
		const q = value[0];
		if ((q === '"' || q === "'") && value.length >= 2 && value.endsWith(q)) {
			value = value.slice(1, -1);
		} else {
			const hash = value.search(/\s#/);
			if (hash >= 0) value = value.slice(0, hash).trim();
		}
		out.push(isRef(value) ? { name, ref: value, line: lineNo } : { name, value, line: lineNo });
	});
	return out;
}

/** Parse `NAME=bws://...` from a --env flag. */
export function parseEnvFlag(s: string): { name: string; ref: string } {
	const eq = s.indexOf('=');
	const name = s.slice(0, eq);
	const ref = s.slice(eq + 1);
	if (eq <= 0 || !NAME_RE.test(name)) throw new UserError(`--env expects NAME=bws://<id>.`, 2);
	if (!isRef(ref)) {
		throw new UserError(`--env ${name}: the value must be a bws:// reference. Never put a secret value on the command line.`, 2);
	}
	return { name, ref };
}
