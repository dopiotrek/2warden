import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { configDir, exec, UserError } from './util.js';

// Where the machine-account access token lives:
// - macOS: login Keychain, service "2warden", account "default".
// - elsewhere: ~/.config/2warden/token, mode 0600.
// - BWS_ACCESS_TOKEN in the environment is the last fallback (least safe:
//   anything the agent runs can read it).

const SERVICE = '2warden';
const ACCOUNT = 'default';
const TOKEN_RE = /^[A-Za-z0-9._:+/=-]+$/;

export type TokenSource = 'keychain' | 'file' | 'env';

function useKeychain(): boolean {
	return process.platform === 'darwin' && !process.env.TWOWARDEN_NO_KEYCHAIN;
}

const tokenFile = () => join(configDir(), 'token');

export async function readToken(): Promise<{ token: string; source: TokenSource } | undefined> {
	if (useKeychain()) {
		const r = await exec('security', ['find-generic-password', '-s', SERVICE, '-a', ACCOUNT, '-w']);
		if (r.code === 0 && r.stdout.trim()) return { token: r.stdout.trim(), source: 'keychain' };
	} else {
		try {
			const t = (await readFile(tokenFile(), 'utf8')).trim();
			if (t) return { token: t, source: 'file' };
		} catch {
			/* no file yet */
		}
	}
	const env = process.env.BWS_ACCESS_TOKEN?.trim();
	if (env) return { token: env, source: 'env' };
	return undefined;
}

export async function requireToken(): Promise<string> {
	const t = await readToken();
	if (!t) {
		throw new UserError(
			'No access token. Create a machine account in Bitwarden Secrets Manager, copy its access token, then run:\n' +
				'  2warden token set'
		);
	}
	return t.token;
}

export async function writeToken(token: string): Promise<TokenSource> {
	const t = token.trim();
	if (!TOKEN_RE.test(t)) {
		// Describe the input without showing it.
		const hints: string[] = [`${t.length} characters`];
		if (/\s/.test(t)) hints.push('contains spaces or line breaks');
		if (!t.startsWith('0.')) hints.push('does not start with "0."');
		throw new UserError(
			`That does not look like a Bitwarden access token (${hints.join(', ')}).\n` +
				'Did the clipboard still hold something else? Copy the token again, or run 2warden token set with no flag and paste it at the prompt'
		);
	}
	if (useKeychain()) {
		// `security -i` reads the command from stdin, so the token never appears in argv.
		const r = await exec('security', ['-i'], {
			input: `add-generic-password -U -s ${SERVICE} -a ${ACCOUNT} -l "2warden access token" -w "${t}"\n`
		});
		if (r.code !== 0) throw new UserError('Could not save the token to the Keychain.');
		return 'keychain';
	}
	await mkdir(configDir(), { recursive: true, mode: 0o700 });
	await writeFile(tokenFile(), t + '\n', { mode: 0o600 });
	return 'file';
}

export async function clearToken(): Promise<void> {
	if (useKeychain()) {
		await exec('security', ['delete-generic-password', '-s', SERVICE, '-a', ACCOUNT]);
	} else {
		await rm(tokenFile(), { force: true });
	}
}
