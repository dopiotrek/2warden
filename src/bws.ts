import { exec, scrub, UserError } from './util.js';

export interface Secret {
	id: string;
	key: string;
	value: string;
	note: string;
	projectId: string | null;
	organizationId: string;
}

export interface Project {
	id: string;
	name: string;
}

/**
 * Thin wrapper over the official `bws` CLI.
 * The access token goes to `bws` through its environment only. Children of
 * `2warden run` never get it.
 */
export class Bws {
	constructor(
		private readonly token: string,
		private readonly server?: string
	) {}

	private bin(): string {
		return process.env.TWOWARDEN_BWS_BIN ?? 'bws';
	}

	/** `secrets` are values to scrub from any error text. */
	private async call(args: string[], secrets: string[] = []): Promise<unknown> {
		const full = [...args, '--output', 'json'];
		if (this.server) full.push('--server-url', this.server);
		const env = { ...process.env, BWS_ACCESS_TOKEN: this.token };
		let r;
		try {
			r = await exec(this.bin(), full, { env });
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
				throw new UserError(
					'The Bitwarden Secrets Manager CLI (bws) is not installed.\n' +
						'  macOS: brew install bitwarden/tap/bws   (or see https://bitwarden.com/help/secrets-manager-cli/)'
				);
			}
			throw e;
		}
		const what = `bws ${args.slice(0, 2).join(' ')}`; // never include later args: they may hold a value
		if (r.code !== 0) {
			const msg = scrub(r.stderr.trim() || r.stdout.trim(), [this.token, ...secrets]);
			throw new UserError(`${what} failed: ${msg || `exit code ${r.code}`}`);
		}
		try {
			return JSON.parse(r.stdout);
		} catch {
			throw new UserError(`${what} returned output that is not JSON.`);
		}
	}

	async listSecrets(projectId?: string): Promise<Secret[]> {
		return (await this.call(projectId ? ['secret', 'list', projectId] : ['secret', 'list'])) as Secret[];
	}

	async getSecret(id: string): Promise<Secret> {
		return (await this.call(['secret', 'get', id])) as Secret;
	}

	/**
	 * Note: `bws secret create` takes the value as an argument. It is visible to
	 * other processes of the same user for the short life of that `bws` call.
	 * The value never passes through the agent's own command line.
	 */
	async createSecret(key: string, value: string, projectId: string, note?: string): Promise<Secret> {
		const args = ['secret', 'create', key, value, projectId];
		if (note) args.push('--note', note);
		return (await this.call(args, [value])) as Secret;
	}

	async listProjects(): Promise<Project[]> {
		return (await this.call(['project', 'list'])) as Project[];
	}

	/** Accept a project id or an exact (case-insensitive) project name. */
	async resolveProject(nameOrId: string): Promise<Project> {
		const projects = await this.listProjects();
		const hit =
			projects.find((p) => p.id === nameOrId) ??
			projects.filter((p) => p.name.toLowerCase() === nameOrId.toLowerCase());
		if (!Array.isArray(hit)) return hit;
		if (hit.length === 1) return hit[0]!;
		if (hit.length > 1) throw new UserError(`More than one project is named "${nameOrId}". Use its id.`);
		const names = projects.map((p) => `  ${p.name}  (${p.id})`).join('\n') || '  (none)';
		throw new UserError(`No project "${nameOrId}" that this access token can see. Projects:\n${names}`);
	}
}
