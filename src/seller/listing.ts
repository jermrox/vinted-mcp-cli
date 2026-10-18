import { CONDITION_ID, type Condition, type Country } from '../client/types.js';

/** What the seller describes; IDs are resolved from names before a listing is saved. */
export interface ListingSpec {
  title: string;
  description: string;
  price: number;
  photos: string[];          // local file paths, in display order (first = cover)
  condition: Condition;
  categoryId: number;        // leaf catalog ID from get_categories
  brand?: string;
  brandId?: number;
  sizeId?: number;
  size?: string;
  colorIds?: number[];
  color?: string[];
  packageSize?: PackageSize;
  isUnisex?: boolean;
  country?: Country;
}

export type PackageSize = 'small' | 'medium' | 'large';

// Vinted's standard parcel options as the upload form sends them.
export const PACKAGE_SIZE_ID: Record<PackageSize, number> = { small: 1, medium: 2, large: 3 };

export const LIMITS = {
  titleMin: 5,
  titleMax: 100,
  descriptionMin: 5,
  descriptionMax: 2000,
  photosMin: 1,
  photosMax: 20,
};

export const PHOTO_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.heic'];

export interface ValidationResult {
  errors: string[];
  warnings: string[];
}

/** Hard errors block publishing; warnings are things that tend to cost sales. */
export function validateListing(s: ListingSpec): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const title = s.title?.trim() ?? '';
  const description = s.description?.trim() ?? '';

  if (title.length < LIMITS.titleMin) errors.push(`title must be at least ${LIMITS.titleMin} characters`);
  if (title.length > LIMITS.titleMax) errors.push(`title must be at most ${LIMITS.titleMax} characters`);
  if (description.length < LIMITS.descriptionMin) errors.push(`description must be at least ${LIMITS.descriptionMin} characters`);
  if (description.length > LIMITS.descriptionMax) errors.push(`description must be at most ${LIMITS.descriptionMax} characters`);
  if (!Number.isFinite(s.price) || s.price <= 0) errors.push('price must be a positive number');
  if (!Object.hasOwn(CONDITION_ID, s.condition)) {
    errors.push(`condition must be one of: ${Object.keys(CONDITION_ID).join(', ')}`);
  }
  if (!Number.isSafeInteger(s.categoryId) || s.categoryId <= 0) {
    errors.push('categoryId is required (a leaf category from get_categories)');
  }
  const photos = s.photos ?? [];
  if (photos.length < LIMITS.photosMin) errors.push('at least one photo is required');
  if (photos.length > LIMITS.photosMax) errors.push(`at most ${LIMITS.photosMax} photos are allowed`);
  for (const p of photos) {
    const ext = p.slice(p.lastIndexOf('.')).toLowerCase();
    if (!PHOTO_EXTENSIONS.includes(ext)) errors.push(`unsupported photo type: ${p}`);
  }
  if (s.packageSize !== undefined && !Object.hasOwn(PACKAGE_SIZE_ID, s.packageSize)) {
    errors.push('packageSize must be small, medium or large');
  }

  if (photos.length && photos.length < 4) warnings.push('listings with 4+ photos (front, back, label, flaws) sell faster');
  if (!s.brandId) warnings.push('no brand set: the item will be listed without a brand');
  if (!s.sizeId) warnings.push('no size set: fine for bags/accessories, required for most clothing and shoes');
  if (!s.colorIds?.length) warnings.push('no colour set: colour filters are widely used by buyers');
  if (description.length < 80) warnings.push('description is short: add measurements, material and any flaws');
  if (!s.packageSize) warnings.push('no packageSize set: defaulting to small');
  return { errors, warnings };
}

/** The item body Vinted's web upload form posts, built from a validated spec and uploaded photo IDs. */
export function buildItemPayload(s: ListingSpec, photoIds: number[], tempUuid: string, currency: string) {
  return {
    id: null,
    currency,
    temp_uuid: tempUuid,
    title: s.title.trim(),
    description: s.description.trim(),
    brand_id: s.brandId ?? null,
    brand: s.brand ?? null,
    size_id: s.sizeId ?? null,
    catalog_id: s.categoryId,
    isbn: null,
    is_unisex: s.isUnisex ?? false,
    status_id: CONDITION_ID[s.condition],
    video_game_rating_id: null,
    price: s.price,
    package_size_id: PACKAGE_SIZE_ID[s.packageSize ?? 'small'],
    shipment_prices: { domestic: null, international: null },
    color_ids: s.colorIds ?? [],
    assigned_photos: photoIds.map((id) => ({ id, orientation: 0 })),
    measurement_length: null,
    measurement_width: null,
    item_attributes: [],
    manufacturer: null,
    manufacturer_labelling: null,
  };
}

export const CURRENCY: Record<Country, string> = {
  fr: 'EUR', de: 'EUR', it: 'EUR', es: 'EUR', nl: 'EUR', pt: 'EUR', be: 'EUR', at: 'EUR',
  lt: 'EUR', sk: 'EUR', hr: 'EUR', fi: 'EUR',
  uk: 'GBP', us: 'USD', pl: 'PLN', cz: 'CZK', hu: 'HUF', ro: 'RON', dk: 'DKK', se: 'SEK',
};
