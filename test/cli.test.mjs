import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { createMasker } from '../dist/mask.js';
import { parseEnvTemplate } from '../dist/envfile.js';

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, '..', 'dist', 'cli.js');
const FAKE = join(here, 'fake-bws.mjs');
chmodSync(FAKE, 0o755);

const OPENAI_ID = '11111111-1111-4111-8111-111111111111';
const STRIPE_ID = '22222222-2222-4222-8222-222222222222';
const OPENAI_VAL = 'sk-openai-SECRET-value-123';
const STRIPE_VAL = 'sk_live_STRIPE_secret_456';
const PROJECT = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'Agent' };

let home, db, arglog;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), '2warden-'));
	db = join(home, 'db.json');
	arglog = join(home, 'args.log');
	writeFileSync(
		db,
		JSON.stringify({
			projects: [PROJECT],
			secrets: [
				{ id: OPENAI_ID, key: 'OPENAI_API_KEY', value: OPENAI_VAL, note: 'note mentions stripe', projectId: PROJECT.id, organizationId: 'org' },
				{ id: STRIPE_ID, key: 'STRIPE_SECRET_KEY', value: STRIPE_VAL, note: '', projectId: PROJECT.id, organizationId: 'org' }
			]
		})
	);
	cli(['token', 'set', '--stdin'], { input: 'good-token\n' });
});

function cli(args, { input, env = {} } = {}) {
	const r = spawnSync(process.execPath, [CLI, ...args], {
		input,
		encoding: 'utf8',
		env: {
			PATH: process.env.PATH,
			TWOWARDEN_HOME: home,
			TWOWARDEN_BWS_BIN: FAKE,
			TWOWARDEN_NO_KEYCHAIN: '1',
			FAKE_BWS_DB: db,
			FAKE_BWS_ARGLOG: arglog,
			...env
		}
	});
	return { code: r.status, out: r.stdout, err: r.stderr, all: r.stdout + r.stderr };
}

const noSecrets = (text) => {
	assert.ok(!text.includes(OPENAI_VAL), 'openai value leaked');
	assert.ok(!text.includes(STRIPE_VAL), 'stripe value leaked');
	assert.ok(!text.includes('good-token'), 'token leaked');
};

test('token is stored and reported without the value', () => {
	const r = cli(['token', 'status']);
	assert.equal(r.code, 0);
	assert.match(r.out, /Token found \(file\)/);
	noSecrets(r.all);
});

test('find returns references, never values', () => {
	const r = cli(['find', 'openai', 'stripe']);
	assert.equal(r.code, 0, r.err);
	assert.match(r.out, new RegExp(`OPENAI_API_KEY\\s+bws://${OPENAI_ID}\\s+Agent`));
	assert.match(r.out, new RegExp(`STRIPE_SECRET_KEY\\s+bws://${STRIPE_ID}`));
	noSecrets(r.all);
});

test('find matches keys only, not notes', () => {
	const r = cli(['find', 'mentions', '--json']);
	assert.deepEqual(JSON.parse(r.out), []);
});

test('find --json has key, ref, project only', () => {
	const r = cli(['find', 'open', '--json']);
	const hits = JSON.parse(r.out);
	assert.deepEqual(hits, [{ key: 'OPENAI_API_KEY', ref: `bws://${OPENAI_ID}`, project: 'Agent' }]);
});

test('run injects the value, masks output, and strips the token', () => {
	writeFileSync(join(home, 'b.txt'), '');
	const script = 'console.log("v=" + process.env.K); console.error("e=" + process.env.K); console.log("t=" + (process.env.BWS_ACCESS_TOKEN ?? "none")); console.log("len=" + process.env.K.length)';
	const r = cli(['run', '--env', `K=bws://${OPENAI_ID}`, '--', process.execPath, '-e', script], {
		env: { BWS_ACCESS_TOKEN: 'good-token' }
	});
	assert.equal(r.code, 0, r.err);
	assert.match(r.out, /v=\*\*\*/);
	assert.match(r.err, /e=\*\*\*/);
	assert.match(r.out, /t=none/);
	assert.match(r.out, new RegExp(`len=${OPENAI_VAL.length}`));
	noSecrets(r.all);
});

test('run --no-mask passes output through as is', () => {
	const r = cli(['run', '--no-mask', '--env', `K=bws://${OPENAI_ID}`, '--', process.execPath, '-e', 'console.log(process.env.K)']);
	assert.equal(r.out.trim(), OPENAI_VAL);
});

test('run refuses a plain value on the command line', () => {
	const r = cli(['run', '--env', 'K=sk-plain-value', '--', 'true']);
	assert.equal(r.code, 2);
	assert.match(r.err, /must be a bws:\/\/ reference/);
});

test('run passes the exit code through', () => {
	const r = cli(['run', '--env', `K=bws://${OPENAI_ID}`, '--', process.execPath, '-e', 'process.exit(7)']);
	assert.equal(r.code, 7);
});

test('run with an unknown reference fails before starting the command', () => {
	const r = cli(['run', '--env', 'K=bws://33333333-3333-4333-8333-333333333333', '--', process.execPath, '-e', 'console.log("started")']);
	assert.notEqual(r.code, 0);
	assert.doesNotMatch(r.out, /started/);
	noSecrets(r.all);
});

test('env run resolves several refs with one list call and keeps plain values', () => {
	const tpl = join(home, '.env.tpl');
	writeFileSync(
		tpl,
		[`# comment`, `export OPENAI_API_KEY=bws://${OPENAI_ID}`, `STRIPE_SECRET_KEY="bws://${STRIPE_ID}"`, `NODE_ENV=development # inline`, ''].join('\n')
	);
	const script = 'console.log([process.env.OPENAI_API_KEY===' + JSON.stringify(OPENAI_VAL) + ', process.env.STRIPE_SECRET_KEY===' + JSON.stringify(STRIPE_VAL) + ', process.env.NODE_ENV].join(","))';
	const r = cli(['env', 'run', tpl, '--', process.execPath, '-e', script]);
	assert.equal(r.code, 0, r.err);
	assert.equal(r.out.trim(), 'true,true,development');
	const calls = readFileSync(arglog, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
	const secretCalls = calls.filter((c) => c[0] === 'secret');
	assert.equal(secretCalls.length, 1, 'expected one bws secret call');
	assert.deepEqual(secretCalls[0].slice(0, 2), ['secret', 'list']);
});

test('env check lists keys, not values', () => {
	const tpl = join(home, '.env.tpl');
	writeFileSync(tpl, `A=bws://${OPENAI_ID}\nB=plain\n`);
	const r = cli(['env', 'check', tpl]);
	assert.equal(r.code, 0, r.err);
	assert.match(r.out, /ok\s+A -> OPENAI_API_KEY/);
	assert.match(r.out, /plain\s+B/);
	noSecrets(r.all);
});

test('create takes the value from stdin, reads it back, prints a ref', () => {
	const r = cli(['create', 'NEW_KEY', '--project', 'agent', '--stdin'], { input: 'brand-new-secret-789\n' });
	assert.equal(r.code, 0, r.err);
	assert.match(r.out.trim(), /^bws:\/\/[0-9a-f-]{36}$/);
	assert.match(r.err, /Read back and checked/);
	assert.ok(!r.all.includes('brand-new-secret-789'));
	const saved = JSON.parse(readFileSync(db, 'utf8')).secrets.find((s) => s.key === 'NEW_KEY');
	assert.equal(saved.value, 'brand-new-secret-789');
});

test('create refuses a duplicate key and shows the existing ref', () => {
	const r = cli(['create', 'OPENAI_API_KEY', '--project', 'Agent', '--stdin'], { input: 'x-value-xxxx' });
	assert.equal(r.code, 1);
	assert.match(r.err, new RegExp(`already exists.*bws://${OPENAI_ID}`, 's'));
});

test('create uses the default project from config', () => {
	cli(['config', 'set', 'project', 'Agent']);
	const r = cli(['create', 'OTHER', '--stdin'], { input: 'value-from-pipe' });
	assert.equal(r.code, 0, r.err);
});

test('create does not leak the value when bws fails, and does not retry', () => {
	const r = cli(['create', 'FAILS', '--project', 'Agent', '--stdin'], {
		input: 'value-that-must-not-leak',
		env: { FAKE_BWS_FAIL_CREATE: '1' }
	});
	assert.equal(r.code, 1);
	assert.ok(!r.all.includes('value-that-must-not-leak'), r.all);
	const creates = readFileSync(arglog, 'utf8').split('\n').filter((l) => l.includes('"create"'));
	assert.equal(creates.length, 1);
});

test('a bad token never shows up in errors', () => {
	cli(['token', 'set', '--stdin'], { input: 'bad-token-zzz' });
	const r = cli(['find', 'x']);
	assert.equal(r.code, 1);
	assert.ok(!r.all.includes('bad-token-zzz'), r.all);
});

test('read prints the value only when asked', () => {
	const r = cli(['read', `bws://${OPENAI_ID}`]);
	assert.equal(r.out.trim(), OPENAI_VAL);
});

test('doctor reports a working setup', () => {
	const r = cli(['doctor']);
	assert.equal(r.code, 0, r.all);
	assert.match(r.out, /sees 1 project\(s\): Agent/);
});

// ---- unit tests

async function maskAll(values, chunks) {
	const m = createMasker(values);
	let out = '';
	m.on('data', (d) => (out += d));
	await new Promise((res) => {
		m.on('end', res);
		Readable.from(chunks.map((c) => Buffer.from(c))).pipe(m);
	});
	return out;
}

test('masker catches values split across chunks', async () => {
	const out = await maskAll(['supersecret'], ['key=super', 'sec', 'ret done\n']);
	assert.equal(out, 'key=*** done\n');
});

test('masker keeps short values and normal text', async () => {
	const out = await maskAll(['abc', 'longsecret'], ['abc longsecret abc lon', 'g']);
	assert.equal(out, 'abc *** abc long');
});

test('masker handles multi-byte characters split across chunks', async () => {
	const buf = Buffer.from('zażółć secretvalue');
	const m = await new Promise((res) => {
		const t = createMasker(['secretvalue']);
		let o = '';
		t.on('data', (d) => (o += d));
		t.on('end', () => res(o));
		t.write(buf.subarray(0, 3));
		t.write(buf.subarray(3));
		t.end();
	});
	assert.equal(m, 'zażółć ***');
});

test('env template parser handles quotes, export and comments', () => {
	const e = parseEnvTemplate(`# c\nexport A=1\nB='two words'\nC=x # note\nD=bws://${OPENAI_ID}\n`);
	assert.deepEqual(
		e.map((x) => [x.name, x.value ?? x.ref]),
		[
			['A', '1'],
			['B', 'two words'],
			['C', 'x'],
			['D', `bws://${OPENAI_ID}`]
		]
	);
});

// ---- import

function writeEnv(text) {
	const dir = mkdtempSync(join(home, 'app-'));
	const f = join(dir, '.env.local');
	writeFileSync(f, text);
	return { dir, f };
}

const ENV_TEXT = [
	'PUBLIC_SUPABASE_ANON_KEY=public-anon-value',
	'STRIPE_SECRET_KEY="sk_test_import_value_1"',
	'DATABASE_URL=postgres://u:pw-import-value@db/x',
	'VERCEL_OIDC_TOKEN=vercel-token-value',
	'PORT=3000',
	'EMPTY_SECRET=',
	'STRIPE_SECRET_KEY=sk_test_import_value_2',
	''
].join('\n');

test('import --dry-run lists secret keys only and saves nothing', () => {
	const { f, dir } = writeEnv(ENV_TEXT);
	const r = cli(['import', f, '--prefix', 'APP_', '--project', 'Agent', '--dry-run']);
	assert.equal(r.code, 0, r.err);
	assert.match(r.out, /APP_STRIPE_SECRET_KEY\s+will create/);
	assert.match(r.out, /APP_DATABASE_URL\s+will create/);
	assert.doesNotMatch(r.out, /PUBLIC_SUPABASE|VERCEL|PORT|EMPTY/);
	assert.ok(!r.all.includes('import_value') && !r.all.includes('pw-import'));
	assert.equal(JSON.parse(readFileSync(db, 'utf8')).secrets.length, 2);
	assert.throws(() => readFileSync(join(dir, '.env.tpl')));
});

test('import saves values (last line wins), writes a template, and is safe to run twice', () => {
	const { f, dir } = writeEnv(ENV_TEXT);
	const r = cli(['import', f, '--prefix', 'APP_', '--project', 'Agent']);
	assert.equal(r.code, 0, r.err);
	assert.ok(!r.all.includes('import_value') && !r.all.includes('pw-import'), r.all);
	const secrets = JSON.parse(readFileSync(db, 'utf8')).secrets;
	assert.equal(secrets.find((s) => s.key === 'APP_STRIPE_SECRET_KEY').value, 'sk_test_import_value_2');
	assert.equal(secrets.find((s) => s.key === 'APP_DATABASE_URL').value, 'postgres://u:pw-import-value@db/x');
	const tpl = readFileSync(join(dir, '.env.tpl'), 'utf8');
	assert.match(tpl, /^STRIPE_SECRET_KEY=bws:\/\/[0-9a-f-]{36}$/m);
	assert.match(tpl, /^DATABASE_URL=bws:\/\/[0-9a-f-]{36}$/m);
	assert.ok(!tpl.includes('import_value'));

	// Template refuses to be overwritten without --force.
	const again = cli(['import', f, '--prefix', 'APP_', '--project', 'Agent']);
	assert.equal(again.code, 1);
	assert.match(again.err, /already exists/);

	// With --force, nothing new is created: both keys exist with the same value.
	const forced = cli(['import', f, '--prefix', 'APP_', '--project', 'Agent', '--force']);
	assert.equal(forced.code, 0, forced.err);
	assert.match(forced.out, /APP_STRIPE_SECRET_KEY\s+exists, same value/);
	assert.equal(JSON.parse(readFileSync(db, 'utf8')).secrets.length, 4);

	// The template works with env run.
	const run = cli(['env', 'run', join(dir, '.env.tpl'), '--', process.execPath, '-e', 'console.log(process.env.STRIPE_SECRET_KEY.length)']);
	assert.equal(run.out.trim(), String('sk_test_import_value_2'.length));
});

test('import requires --prefix', () => {
	const { f } = writeEnv(ENV_TEXT);
	const r = cli(['import', f, '--project', 'Agent']);
	assert.equal(r.code, 2);
	assert.match(r.err, /--prefix/);
});
