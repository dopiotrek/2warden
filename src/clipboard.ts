import { exec, UserError } from './util.js';

const READERS: Record<string, [string, string[]][]> = {
	darwin: [['pbpaste', []]],
	win32: [['powershell', ['-NoProfile', '-Command', 'Get-Clipboard -Raw']]],
	linux: [
		['wl-paste', ['-n']],
		['xclip', ['-selection', 'clipboard', '-o']],
		['xsel', ['--clipboard', '--output']]
	]
};

const WRITERS: Record<string, [string, string[]][]> = {
	darwin: [['pbcopy', []]],
	win32: [['clip', []]],
	linux: [
		['wl-copy', []],
		['xclip', ['-selection', 'clipboard']],
		['xsel', ['--clipboard', '--input']]
	]
};

async function firstWorking(list: [string, string[]][] | undefined, input?: string): Promise<string> {
	for (const [cmd, args] of list ?? []) {
		try {
			const r = await exec(cmd, args, { input });
			if (r.code === 0) return r.stdout;
		} catch {
			/* not installed, try the next one */
		}
	}
	throw new UserError('No clipboard tool found. Use --stdin instead.');
}

export async function readClipboard(): Promise<string> {
	return firstWorking(READERS[process.platform]);
}

export async function writeClipboard(text: string): Promise<void> {
	await firstWorking(WRITERS[process.platform], text);
}
