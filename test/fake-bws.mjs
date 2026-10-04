#!/usr/bin/env node
// A stand-in for the real `bws` CLI, enough for the tests.
// State lives in the JSON file named by FAKE_BWS_DB.
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const dbPath = process.env.FAKE_BWS_DB;
const args = process.argv.slice(2);
if (process.env.FAKE_BWS_ARGLOG) appendFileSync(process.env.FAKE_BWS_ARGLOG, JSON.stringify(args) + '\n');

if (args[0] === '--version') {
	console.log('bws 1.0.0 (fake)');
	process.exit(0);
}
if (process.env.BWS_ACCESS_TOKEN !== 'good-token') {
	console.error(`Error: invalid access token ${process.env.BWS_ACCESS_TOKEN}`);
	process.exit(1);
}

// strip --output json / --server-url x
const pos = [];
const opts = {};
for (let i = 0; i < args.length; i++) {
	if (args[i].startsWith('--')) opts[args[i].slice(2)] = args[++i];
	else pos.push(args[i]);
}
const db = JSON.parse(readFileSync(dbPath, 'utf8'));
const save = () => writeFileSync(dbPath, JSON.stringify(db));
const out = (x) => console.log(JSON.stringify(x));

const [group, verb, ...rest] = pos;
if (group === 'project' && verb === 'list') out(db.projects);
else if (group === 'secret' && verb === 'list') out(rest[0] ? db.secrets.filter((s) => s.projectId === rest[0]) : db.secrets);
else if (group === 'secret' && verb === 'get') {
	const s = db.secrets.find((x) => x.id === rest[0]);
	if (!s) {
		console.error('Error: 404 Not Found');
		process.exit(1);
	}
	out(s);
} else if (group === 'secret' && verb === 'create') {
	const [key, value, projectId] = rest;
	if (process.env.FAKE_BWS_FAIL_CREATE) {
		console.error(`Error: server said no to ${value}`);
		process.exit(1);
	}
	const s = { object: 'secret', id: randomUUID(), organizationId: 'org', projectId, key, value, note: opts.note ?? '' };
	db.secrets.push(s);
	save();
	out(s);
} else {
	console.error('fake bws: unknown command ' + pos.join(' '));
	process.exit(2);
}
