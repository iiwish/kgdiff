/**
 * Example dataset metadata (`examples/datasets/index.json` + each `meta.json`), bundled at build
 * time. The files themselves are loaded on demand by the playground.
 */
import type { DiffOptions, Locale } from '@kgdiff/core';

export interface DatasetMeta {
  readonly id: string;
  readonly title: Readonly<Record<Locale, string>>;
  readonly description: Readonly<Record<Locale, string>>;
  readonly format: string;
  readonly files: { readonly before: string; readonly after: string };
  readonly versions?: { readonly before?: string; readonly after?: string };
  readonly options?: DiffOptions;
  readonly featured?: boolean;
  readonly license?: string;
}

interface IndexEntry {
  readonly id: string;
  readonly format: string;
  readonly featured?: boolean;
  readonly tags?: readonly string[];
  readonly language?: Locale;
  readonly translationOf?: string;
}

export interface Dataset extends DatasetMeta {
  readonly tags: readonly string[];
  /** Language of the data itself (labels, descriptions), given when it has a translation. */
  readonly language?: Locale;
  /** The dataset this one translates: the same graphs and changes, every text translated. */
  readonly translationOf?: string;
}

const index = import.meta.glob<{ readonly datasets: readonly IndexEntry[] }>(
  '../../../../examples/datasets/index.json',
  { eager: true, import: 'default' },
);
const metas = import.meta.glob<DatasetMeta>('../../../../examples/datasets/*/meta.json', {
  eager: true,
  import: 'default',
});

function load(): Dataset[] {
  const byId = new Map<string, DatasetMeta>();
  for (const meta of Object.values(metas)) byId.set(meta.id, meta);
  const entries = Object.values(index)[0]?.datasets ?? [];
  const out: Dataset[] = [];
  for (const entry of entries) {
    const meta = byId.get(entry.id);
    if (!meta) continue;
    out.push({
      ...meta,
      tags: entry.tags ?? [],
      ...(entry.language ? { language: entry.language } : {}),
      ...(entry.translationOf ? { translationOf: entry.translationOf } : {}),
    });
  }
  return out;
}

/** All example datasets, in display order. */
export const DATASETS: readonly Dataset[] = load();

export function datasetById(id: string | null | undefined): Dataset | undefined {
  return id ? DATASETS.find((d) => d.id === id) : undefined;
}

/** `d` with its data in the language of `locale`: its translation when it has one, else `d`. */
export function inLanguage(d: Dataset, locale: Locale): Dataset {
  if (d.language === undefined || d.language === locale) return d;
  const original = d.translationOf ?? d.id;
  return DATASETS.find((x) => (x.translationOf ?? x.id) === original && x.language === locale) ?? d;
}

/** The datasets to list for `locale`, in display order: one per translation, in `locale`. */
export function datasetsFor(locale: Locale): Dataset[] {
  return DATASETS.filter((d) => inLanguage(d, locale) === d);
}

/** The dataset featured first: the enterprise KG, with its data in the language of `locale`. */
export function featuredFor(locale: Locale): Dataset {
  const d = datasetById('enterprise-kg') ?? DATASETS[0];
  if (!d) throw new Error('No example datasets were bundled.');
  return inLanguage(d, locale);
}

/** Human label of a dataset's file format. */
export function formatLabel(format: string): string {
  switch (format) {
    case 'json':
      return 'JSON';
    case 'turtle':
      return 'Turtle';
    case 'obo':
      return 'OBO';
    case 'ntriples':
      return 'N-Triples';
    case 'nquads':
      return 'N-Quads';
    case 'trig':
      return 'TriG';
    case 'rdfxml':
      return 'RDF/XML';
    case 'jsonld':
      return 'JSON-LD';
    default:
      return format;
  }
}
