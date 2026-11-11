/**
 * Embedded report payloads: `<script type="application/kgdiff+json">` elements written by the
 * CLI's HTML report, optionally gzip-compressed and base64-encoded
 * (`data-encoding="gzip-base64"`), decoded with the platform `DecompressionStream`.
 */
import { KgdiffError } from '@kgdiff/core';
import type { ReportPayload } from './index.js';
import { viewerTags } from './registry.js';

export const PAYLOAD_TYPE = 'application/kgdiff+json';

function base64ToBytes(text: string): Uint8Array {
  const clean = text.replace(/\s+/g, '');
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function gunzip(bytes: Uint8Array): Promise<string> {
  if (typeof DecompressionStream !== 'function') {
    throw new KgdiffError(
      'invalid-input',
      'This browser cannot decompress the embedded report (DecompressionStream is missing).',
    );
  }
  const input = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  const reader = input
    .pipeThrough(
      new DecompressionStream('gzip') as unknown as TransformStream<Uint8Array, Uint8Array>,
    )
    .getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return new TextDecoder().decode(out);
}

/** Decode the text of a payload script. `encoding` is its `data-encoding` attribute. */
export async function decodePayloadText(
  text: string,
  encoding: string | null | undefined,
): Promise<ReportPayload> {
  let json: string;
  const enc = (encoding ?? '').trim().toLowerCase();
  if (enc === '' || enc === 'json' || enc === 'identity') json = text;
  else if (enc === 'gzip-base64') {
    try {
      json = await gunzip(base64ToBytes(text));
    } catch (error) {
      if (error instanceof KgdiffError) throw error;
      throw new KgdiffError(
        'invalid-input',
        `The embedded report is not valid gzip-base64: ${(error as Error).message}`,
      );
    }
  } else {
    throw new KgdiffError('invalid-input', `Unknown payload encoding "${encoding}".`);
  }
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (error) {
    throw new KgdiffError(
      'invalid-input',
      `The embedded report is not valid JSON: ${(error as Error).message}`,
    );
  }
  return assertPayload(value);
}

/**
 * Validate the envelope of a report payload (the diff and layout are validated when read). The
 * layout is optional: left out, the viewer lays the diff out itself.
 */
export function assertPayload(value: unknown): ReportPayload {
  if (typeof value !== 'object' || value === null) {
    throw new KgdiffError('invalid-input', 'A kgdiff report payload must be an object.');
  }
  const v = value as Partial<ReportPayload>;
  if (v.format !== 'kgdiff.report') {
    throw new KgdiffError(
      'invalid-input',
      `Expected format "kgdiff.report", got ${JSON.stringify(v.format)}.`,
    );
  }
  if (v.version !== 1) {
    throw new KgdiffError(
      'unsupported-version',
      `Unsupported kgdiff report version ${JSON.stringify(v.version)} (this viewer reads version 1).`,
    );
  }
  if (typeof v.diff !== 'object' || v.diff === null) {
    throw new KgdiffError('invalid-input', 'A kgdiff report needs a `diff`.');
  }
  if (v.layout !== undefined && (typeof v.layout !== 'object' || v.layout === null)) {
    throw new KgdiffError(
      'invalid-input',
      'The `layout` of a kgdiff report must be a kgdiff.layout document, or be left out.',
    );
  }
  return value as ReportPayload;
}

function findById(root: ParentNode, id: string): Element | null {
  const doc = root as Partial<Document>;
  if (typeof doc.getElementById === 'function') return doc.getElementById(id);
  return root.querySelector(`[id="${id.replace(/["\\]/g, '\\$&')}"]`);
}

function firstViewer(root: ParentNode): Element | null {
  for (const el of root.querySelectorAll('*')) {
    if (viewerTags.has(el.localName)) return el;
  }
  return null;
}

/** The viewer a payload script targets: `data-for="<id>"`, else the first viewer in `root`. */
function payloadTarget(script: Element, root: ParentNode): Element | null {
  const id = script.getAttribute('data-for');
  return id ? findById(root, id) : firstViewer(root);
}

interface PayloadReceiver {
  payload: ReportPayload | null;
}

export async function hydrate(root: ParentNode): Promise<void> {
  const scripts = [...root.querySelectorAll(`script[type="${PAYLOAD_TYPE}"]`)];
  await Promise.all(
    scripts.map(async (script) => {
      const target = payloadTarget(script, root);
      try {
        const payload = await decodePayloadText(
          script.textContent ?? '',
          script.getAttribute('data-encoding'),
        );
        if (target) (target as unknown as PayloadReceiver).payload = payload;
      } catch (error) {
        const err =
          error instanceof Error ? error : new KgdiffError('invalid-input', String(error));
        if (target) {
          const showError = (target as Partial<{ showError(e: Error): void }>).showError;
          if (typeof showError === 'function') showError.call(target, err);
          else {
            target.dispatchEvent(
              new CustomEvent('kgdiff-error', {
                detail: { error: err },
                bubbles: true,
                composed: true,
              }),
            );
          }
        } else console.error('[kgdiff] embedded payload:', err);
      }
    }),
  );
}
