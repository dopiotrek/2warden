import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** An error we expect and show to the user without a stack trace. */
export class UserError extends Error {
	constructor(
		message: string,
		readonly exitCode = 1
	) {
		super(message);
	}
}

export interface ExecResult {
	code: number;
	stdout: string;
	stderr: string;
}

/** Run a program, capture output. `input` goes to stdin, so it never shows up in argv. */
export function exec(
	cmd: string,
	args: string[],
	opts: { env?: NodeJS.ProcessEnv; input?: string } = {}
): Promise<ExecResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(cmd, args, {
			env: opts.env ?? process.env,
			stdio: ['pipe', 'pipe', 'pipe']
		});
		let stdout = '';
		let stderr = '';
		child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
		child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
		child.on('error', reject);
		child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
		child.stdin.end(opts.input ?? '');
	});
}

export function configDir(): string {
	return process.env.TWOWARDEN_HOME ?? join(homedir(), '.config', '2warden');
}

/** Remove every known secret value from a string before we show it. */
export function scrub(text: string, secrets: readonly string[]): string {
	let out = text;
	for (const s of secrets) if (s.length > 0) out = out.split(s).join('***');
	return out;
}

/** Read all of stdin as text. */
export async function readStdin(): Promise<string> {
	if (process.stdin.isTTY) throw new UserError('--stdin needs piped input, for example: pbpaste | 2warden ...');
	const chunks: Buffer[] = [];
	for await (const c of process.stdin) chunks.push(c as Buffer);
	return Buffer.concat(chunks).toString('utf8');
}

/** Drop one trailing newline (from `echo` or a file), keep everything else as typed. */
export function trimOneNewline(s: string): string {
	return s.replace(/\r?\n$/, '');
}
