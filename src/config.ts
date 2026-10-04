import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { configDir } from './util.js';

export interface Config {
	/** Default project (name or id) for `create`. */
	project?: string;
	/** Bitwarden server, e.g. https://vault.bitwarden.eu */
	server?: string;
}

const file = () => join(configDir(), 'config.json');

export async function loadConfig(): Promise<Config> {
	try {
		return JSON.parse(await readFile(file(), 'utf8')) as Config;
	} catch {
		return {};
	}
}

export async function saveConfig(c: Config): Promise<void> {
	await mkdir(configDir(), { recursive: true, mode: 0o700 });
	await writeFile(file(), JSON.stringify(c, null, 2) + '\n', { mode: 0o600 });
}
