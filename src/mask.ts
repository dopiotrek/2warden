import { StringDecoder } from 'node:string_decoder';
import { Transform, type TransformCallback } from 'node:stream';

export const MASK = '***';

/** Values shorter than this are not masked: masking "1" or "abc" would wreck normal output. */
export const MIN_MASK_LENGTH = 6;

/**
 * A stream that replaces every secret value with ***.
 * It holds back a short tail between chunks, so a value split across two
 * chunks is still caught.
 */
export function createMasker(values: readonly string[]): Transform {
	const secrets = [...new Set(values.filter((v) => v.length >= MIN_MASK_LENGTH))].sort((a, b) => b.length - a.length);
	const maxLen = secrets[0]?.length ?? 0;
	const decoder = new StringDecoder('utf8');
	let pending = '';

	const process = (text: string, final: boolean): string => {
		if (maxLen === 0) return text;
		let out = '';
		let i = 0;
		outer: while (i < text.length) {
			for (const s of secrets) {
				if (text.startsWith(s, i)) {
					out += MASK;
					i += s.length;
					continue outer;
				}
			}
			// Near the end and not final: a secret might start here and finish in the next chunk.
			if (!final && text.length - i < maxLen) {
				const rest = text.slice(i);
				if (secrets.some((s) => s.startsWith(rest))) {
					pending = rest;
					return out;
				}
			}
			out += text[i];
			i++;
		}
		pending = '';
		return out;
	};

	return new Transform({
		transform(chunk: Buffer, _enc, cb: TransformCallback) {
			cb(null, process(pending + decoder.write(chunk), false));
		},
		flush(cb: TransformCallback) {
			cb(null, process(pending + decoder.end(), true));
		}
	});
}
