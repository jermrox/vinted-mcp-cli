import { mkdir, readFile, readdir, writeFile, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ListingSpec } from './listing.js';

export type ListingStatus = 'prepared' | 'vinted_draft' | 'published' | 'failed';

export interface StoredListing {
  id: string;
  status: ListingStatus;
  spec: ListingSpec;
  warnings: string[];
  createdAt: string;
  updatedAt: string;
  vintedItemId?: number;
  vintedDraftId?: number;
  url?: string;
  lastError?: string;
}

/** Everything the seller tools keep locally: browser profile and prepared listings. */
export function vintedHome(): string {
  return process.env.VINTED_HOME ?? join(homedir(), '.vinted-mcp');
}

function listingsDir(): string {
  return join(vintedHome(), 'listings');
}

const ID_RE = /^[a-z0-9-]{8,64}$/;

function pathFor(id: string): string {
  if (!ID_RE.test(id)) throw new Error(`Invalid listing id: ${id}`);
  return join(listingsDir(), `${id}.json`);
}

export async function saveListing(
  spec: ListingSpec,
  warnings: string[],
  id?: string,
): Promise<StoredListing> {
  const now = new Date().toISOString();
  const prev = id ? await loadListing(id).catch(() => undefined) : undefined;
  const listing: StoredListing = {
    ...prev,
    id: id ?? randomUUID(),
    status: prev?.status === 'published' ? 'published' : 'prepared',
    spec,
    warnings,
    createdAt: prev?.createdAt ?? now,
    updatedAt: now,
  };
  await writeListing(listing);
  return listing;
}

export async function writeListing(listing: StoredListing): Promise<void> {
  await mkdir(listingsDir(), { recursive: true });
  const file = pathFor(listing.id);
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(listing, null, 2));
  await rename(tmp, file);
}

export async function loadListing(id: string): Promise<StoredListing> {
  try {
    return JSON.parse(await readFile(pathFor(id), 'utf8'));
  } catch (e: any) {
    if (e?.code === 'ENOENT') throw new Error(`No prepared listing with id ${id}. Run prepare_listing first.`);
    throw e;
  }
}

export async function listListings(): Promise<StoredListing[]> {
  let names: string[];
  try {
    names = await readdir(listingsDir());
  } catch (e: any) {
    if (e?.code === 'ENOENT') return [];
    throw e;
  }
  const out: StoredListing[] = [];
  for (const n of names.filter((f) => f.endsWith('.json'))) {
    try {
      out.push(JSON.parse(await readFile(join(listingsDir(), n), 'utf8')));
    } catch { /* skip a half-written or hand-edited file */ }
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
