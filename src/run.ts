import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import { createMasker } from './mask.js';
import { UserError } from './util.js';

/** Variables that must never reach a child process. */
const STRIP = ['BWS_ACCESS_TOKEN'];

/**
 * Start `cmd` with `inject` added to its environment.
 * With `maskValues`, the child's stdout and stderr go through a filter that
 * replaces those values with ***. Returns the child's exit code.
 */
export function runChild(cmd: string[], inject: Record<string, string>, maskValues: string[] | null): Promise<number> {
	if (cmd.length === 0) throw new UserError('Missing command. Usage: ... -- <command> [args]', 2);
	const env: NodeJS.ProcessEnv = { ...process.env };
	for (const k of STRIP) delete env[k];
	Object.assign(env, inject);

	const mask = maskValues !== null && maskValues.length > 0;
	const child = spawn(cmd[0]!, cmd.slice(1), {
		env,
		stdio: ['inherit', mask ? 'pipe' : 'inherit', mask ? 'pipe' : 'inherit']
	});

	if (mask) {
		child.stdout!.pipe(createMasker(maskValues)).pipe(process.stdout);
		child.stderr!.pipe(createMasker(maskValues)).pipe(process.stderr);
	}

	const forward = (sig: NodeJS.Signals) => () => child.kill(sig);
	const onInt = forward('SIGINT');
	const onTerm = forward('SIGTERM');
	process.on('SIGINT', onInt);
	process.on('SIGTERM', onTerm);

	return new Promise((resolve) => {
		child.on('error', (e: NodeJS.ErrnoException) => {
			process.stderr.write(`2warden: could not start "${cmd[0]}": ${e.code ?? e.message}\n`);
			resolve(127);
		});
		child.on('close', (code, signal) => {
			process.off('SIGINT', onInt);
			process.off('SIGTERM', onTerm);
			if (signal) resolve(128 + (constants.signals[signal] ?? 1));
			else resolve(code ?? 1);
		});
	});
}
