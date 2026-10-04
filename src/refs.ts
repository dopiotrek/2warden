import type { Bws, Secret } from './bws.js';
import { UserError } from './util.js';

// A reference is `bws://<secret-uuid>`. It is safe to print, log and commit.

const REF_RE = /^bws:\/\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export function toRef(id: string): string {
	return `bws://${id.toLowerCase()}`;
}

export function isRef(s: string): boolean {
	return REF_RE.test(s.trim());
}

export function parseRef(s: string): string {
	const m = REF_RE.exec(s.trim());
	if (!m) throw new UserError(`Not a 2warden reference: "${s}". Expected bws://<secret-id>. Use \`2warden find\` to get one.`);
	return m[1]!.toLowerCase();
}

/**
 * Resolve many references with as few `bws` calls as possible.
 * Returns id -> secret. Fails if any reference is missing; the error names refs only.
 */
export async function resolveRefs(bws: Bws, refs: string[]): Promise<Map<string, Secret>> {
	const ids = [...new Set(refs.map(parseRef))];
	const out = new Map<string, Secret>();
	if (ids.length === 0) return out;
	if (ids.length === 1) {
		try {
			const s = await bws.getSecret(ids[0]!);
			out.set(ids[0]!, s);
		} catch {
			throw new UserError(`Could not read ${toRef(ids[0]!)}. It does not exist, or this access token cannot see it.`);
		}
		return out;
	}
	const all = await bws.listSecrets();
	const byId = new Map(all.map((s) => [s.id.toLowerCase(), s]));
	const missing: string[] = [];
	for (const id of ids) {
		const s = byId.get(id);
		if (s) out.set(id, s);
		else missing.push(toRef(id));
	}
	if (missing.length) {
		throw new UserError(`These references do not exist, or this access token cannot see them:\n  ${missing.join('\n  ')}`);
	}
	return out;
}
