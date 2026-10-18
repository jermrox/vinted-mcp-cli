import { readdir, stat } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { VintedClient } from '../client/session.js';
import { DOMAIN, type Country } from '../client/types.js';
import { resolveBrandIds } from '../ops/brands.js';
import { resolveColorIds } from '../ops/get-colors.js';
import { resolveSizeIds } from '../ops/sizes.js';
import { opSellerItems } from '../ops/seller-items.js';
import { api, describe, requireUserId, uploadPhoto, waitForLogin, withAccount, type AccountPage } from './account.js';
import { buildItemPayload, CURRENCY, PHOTO_EXTENSIONS, validateListing, type ListingSpec } from './listing.js';
import { listListings, loadListing, saveListing, writeListing, type StoredListing } from './store.js';

export function accountCountry(country?: Country): Country {
  return country ?? (process.env.VINTED_ACCOUNT_COUNTRY as Country | undefined) ?? 'fr';
}

export interface AccountProfile {
  id: number;
  username: string;
  profileUrl: string;
  itemCount?: number;
  feedbackReputation?: number;
  feedbackCount?: number;
  hasPhoto: boolean;
  about: string;
  emailVerified?: boolean;
  phoneVerified?: boolean;
  onHoliday?: boolean;
}

export interface Readiness {
  ready: boolean;
  todo: string[];
}

export function readiness(p: AccountProfile): Readiness {
  const todo: string[] = [];
  if (!p.hasPhoto) todo.push('Add a profile photo (Profile > Edit profile): faceless accounts get fewer sales.');
  if (p.about.trim().length < 30) todo.push('Write a short bio: what you sell, that you ship fast, bundle discounts welcome.');
  if (p.emailVerified === false) todo.push('Verify your email address (Settings > Account settings).');
  if (p.phoneVerified === false) todo.push('Verify your phone number: Vinted asks for it before your first payout.');
  if (p.onHoliday) todo.push('Holiday mode is ON: your listings are hidden until you switch it off.');
  todo.push(
    'Check that a payout method is set (Settings > Payments): Vinted holds earnings until one is added.',
    'Turn on bundle discounts (Settings > Bundle discounts) to sell more per order.',
    'Pick the shipping carriers you can drop off at (Settings > Shipping).',
  );
  return { ready: todo.length === 3, todo };
}

async function fetchProfile(a: AccountPage, id: number): Promise<AccountProfile> {
  const r = await api(a, 'GET', `/api/v2/users/${id}`);
  const u = r.json?.user;
  if (r.status !== 200 || !u) throw new Error(`Could not load your profile (HTTP ${r.status}): ${describe(r)}`);
  return {
    id,
    username: String(u.login ?? ''),
    profileUrl: `https://${DOMAIN[a.country]}/member/${id}`,
    itemCount: u.item_count ?? undefined,
    feedbackReputation: u.feedback_reputation ?? undefined,
    feedbackCount: u.feedback_count ?? undefined,
    hasPhoto: Boolean(u.photo && !u.photo.is_hidden && u.photo.url),
    about: String(u.about ?? ''),
    emailVerified: u.verification?.email?.valid ?? undefined,
    phoneVerified: u.verification?.phone?.valid ?? undefined,
    onHoliday: u.is_on_holiday ?? undefined,
  };
}

export async function opAccountLogin(input: { country?: Country; timeoutSec?: number }) {
  const country = accountCountry(input.country);
  const timeoutMs = Math.min(Math.max(input.timeoutSec ?? 300, 30), 900) * 1000;
  return withAccount(country, async (a) => {
    const id = await waitForLogin(a, timeoutMs);
    const profile = await fetchProfile(a, id);
    return { loggedIn: true, profile, readiness: readiness(profile) };
  }, { headless: false });
}

export async function opAccountStatus(input: { country?: Country }) {
  const country = accountCountry(input.country);
  return withAccount(country, async (a) => {
    const profile = await fetchProfile(a, await requireUserId(a));
    return { loggedIn: true, profile, readiness: readiness(profile) };
  });
}

export async function opMyListings(client: VintedClient, input: { country?: Country; page?: number }) {
  const country = accountCountry(input.country);
  const userId = await withAccount(country, requireUserId);
  const [live, local] = await Promise.all([
    opSellerItems(client, { sellerId: userId, country, limit: 96, page: input.page ?? 1 }),
    listListings(),
  ]);
  return {
    live,
    prepared: local.map((l) => ({
      id: l.id, status: l.status, title: l.spec.title, price: l.spec.price, url: l.url, updatedAt: l.updatedAt,
    })),
  };
}

export type PrepareInput = Partial<ListingSpec> & {
  folder?: string;
  listingId?: string;
  color?: string[] | string;
};

/** Photos in a folder, ordered by file name so "1-front.jpg, 2-back.jpg…" controls the cover. */
export async function photosInFolder(folder: string): Promise<string[]> {
  const dir = resolve(folder);
  const names = await readdir(dir);
  return names
    .filter((n) => !n.startsWith('.') && PHOTO_EXTENSIONS.includes(extname(n).toLowerCase()))
    .sort((x, y) => x.localeCompare(y, undefined, { numeric: true }))
    .map((n) => join(dir, n));
}

async function checkFiles(paths: string[]): Promise<string[]> {
  const errors: string[] = [];
  for (const p of paths) {
    try {
      const s = await stat(p);
      if (!s.isFile()) errors.push(`not a file: ${p}`);
      else if (s.size > 20 * 1024 * 1024) errors.push(`photo larger than 20 MB: ${p}`);
    } catch {
      errors.push(`photo not found: ${p}`);
    }
  }
  return errors;
}

export async function opPrepareListing(client: VintedClient, input: PrepareInput) {
  const country = accountCountry(input.country);
  const prev = input.listingId ? (await loadListing(input.listingId)).spec : undefined;
  const merged: Partial<ListingSpec> & { color?: string[] | string } = { ...prev, ...stripUndefined(input) };
  delete (merged as any).folder;
  delete (merged as any).listingId;

  const photos = input.folder
    ? [...(await photosInFolder(input.folder)), ...(input.photos ?? [])]
    : (merged.photos ?? []).map((p) => resolve(p));
  const notes: string[] = [];

  let brandId = merged.brandId;
  let brand = merged.brand;
  if (!brandId && brand) {
    const r = await resolveBrandIds(client, [brand], country);
    if (r.resolved[0]) ({ id: brandId, title: brand } = r.resolved[0]);
    else notes.push(`brand "${brand}" not found on Vinted: listing without a brand ID`);
  }

  let sizeId = merged.sizeId;
  if (!sizeId && merged.size) {
    const r = await resolveSizeIds(client, [merged.size], country);
    if (r.resolved.length === 1) sizeId = r.resolved[0].id;
    else if (r.resolved.length > 1) {
      notes.push(`size "${merged.size}" matches several size groups; pass sizeId. Options: ` +
        r.resolved.map((s) => `${s.id} (${s.group})`).join(', '));
    } else notes.push(`size "${merged.size}" not recognised; pass sizeId from get_size_groups`);
  }

  let colorIds = merged.colorIds;
  const colorNames = typeof merged.color === 'string' ? merged.color.split(',') : merged.color;
  if (!colorIds?.length && colorNames?.length) {
    const r = await resolveColorIds(client, colorNames.map((c) => c.trim()).filter(Boolean), country);
    colorIds = r.ids.slice(0, 2);
    if (r.unresolved.length) notes.push(`colour(s) not recognised: ${r.unresolved.join(', ')}`);
  }

  const spec: ListingSpec = {
    title: merged.title ?? '',
    description: merged.description ?? '',
    price: Number(merged.price),
    photos,
    condition: merged.condition as ListingSpec['condition'],
    categoryId: Number(merged.categoryId),
    brand,
    brandId,
    size: merged.size,
    sizeId,
    colorIds,
    packageSize: merged.packageSize,
    isUnisex: merged.isUnisex,
    country,
  };
  const v = validateListing(spec);
  const errors = [...v.errors, ...(await checkFiles(photos))];
  const warnings = [...notes, ...v.warnings];
  const saved = await saveListing(spec, warnings, input.listingId);
  return {
    listingId: saved.id,
    readyToPublish: errors.length === 0,
    errors,
    warnings,
    preview: {
      title: spec.title,
      price: `${spec.price} ${CURRENCY[country]}`,
      condition: spec.condition,
      brand: spec.brand ?? null,
      sizeId: spec.sizeId ?? null,
      categoryId: spec.categoryId,
      colorIds: spec.colorIds ?? [],
      packageSize: spec.packageSize ?? 'small',
      photos: spec.photos,
      description: spec.description,
    },
    next: errors.length
      ? 'Fix the errors and call prepare_listing again with this listingId.'
      : 'Show the preview to the seller. Only after they approve, call publish_listing with confirm: true.',
  };
}

export async function opPublishListing(input: { listingId: string; confirm?: boolean; asDraft?: boolean }) {
  if (!input.listingId) throw new Error('listingId is required');
  if (input.confirm !== true) {
    throw new Error('publish_listing changes the seller\'s live Vinted account: pass confirm: true only after the seller approved the preview.');
  }
  const listing = await loadListing(input.listingId);
  if (listing.status === 'published') {
    throw new Error(`Listing already published as ${listing.url}. Prepare a new listing instead of publishing twice.`);
  }
  const spec = listing.spec;
  const country = accountCountry(spec.country);
  const errors = [...validateListing(spec).errors, ...(await checkFiles(spec.photos))];
  if (errors.length) throw new Error(`Listing is not ready: ${errors.join('; ')}`);

  try {
    const result = await withAccount(country, async (a) => {
      await requireUserId(a);
      const tempUuid = randomUUID();
      const photoIds: number[] = [];
      for (const p of spec.photos) photoIds.push(await uploadPhoto(a, p, tempUuid));
      const payload = buildItemPayload(spec, photoIds, tempUuid, CURRENCY[country]);
      const common = { feedback_id: null, parcel: null, upload_session_id: randomUUID() };
      const r = input.asDraft
        ? await api(a, 'POST', '/api/v2/item_upload/drafts', { draft: payload, ...common })
        : await api(a, 'POST', '/api/v2/item_upload/items', { item: payload, push_up: false, ...common });
      const id = Number(r.json?.item?.id ?? r.json?.draft?.id);
      if (r.status >= 300 || !Number.isSafeInteger(id)) {
        throw new Error(`Vinted rejected the ${input.asDraft ? 'draft' : 'listing'} (HTTP ${r.status}): ${describe(r)}`);
      }
      return { id, photoCount: photoIds.length };
    });

    const updated: StoredListing = input.asDraft
      ? { ...listing, status: 'vinted_draft', vintedDraftId: result.id, lastError: undefined }
      : { ...listing, status: 'published', vintedItemId: result.id, url: `https://${DOMAIN[country]}/items/${result.id}`, lastError: undefined };
    updated.updatedAt = new Date().toISOString();
    await writeListing(updated);
    return {
      listingId: listing.id,
      status: updated.status,
      vintedId: result.id,
      url: updated.url,
      photosUploaded: result.photoCount,
      next: input.asDraft
        ? 'Saved to Drafts in the seller\'s Vinted app: they review it there and tap Upload to make it live.'
        : 'Live on Vinted. Open the URL to check it.',
    };
  } catch (e) {
    await writeListing({ ...listing, status: 'failed', lastError: e instanceof Error ? e.message : String(e), updatedAt: new Date().toISOString() });
    throw e;
  }
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
