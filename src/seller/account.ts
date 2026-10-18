import { readFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { DOMAIN, type Country } from '../client/types.js';
import { loadStealthChromium, toPlaywrightProxy } from '../client/browser.js';
import { vintedHome } from './store.js';

/**
 * The seller tools drive a real Chromium profile the seller logged into themselves.
 * Calls run inside the page, so they carry Vinted's own cookies, CSRF token and TLS fingerprint;
 * no password ever passes through this process.
 */
export interface AccountPage {
  country: Country;
  page: any;
  context: any;
}

export interface ApiResponse<T = any> {
  status: number;
  json?: T;
  text?: string;
}

export function profileDir(): string {
  return process.env.VINTED_PROFILE_DIR ?? join(vintedHome(), 'profile');
}

let queue: Promise<unknown> = Promise.resolve();

/** A persistent profile can only be open once, so account calls run one at a time. */
export function withAccount<T>(
  country: Country,
  fn: (a: AccountPage) => Promise<T>,
  opts: { headless?: boolean } = {},
): Promise<T> {
  const run = queue.then(() => openAndRun(country, fn, opts));
  queue = run.catch(() => {});
  return run;
}

async function openAndRun<T>(
  country: Country,
  fn: (a: AccountPage) => Promise<T>,
  opts: { headless?: boolean },
): Promise<T> {
  const chromium = await loadStealthChromium();
  const proxyUrl = process.env.VINTED_PROXY_URL;
  // Visible by default: the seller can watch every action taken on their account.
  const headless = opts.headless ?? process.env.VINTED_ACCOUNT_HEADLESS === '1';
  const context = await chromium.launchPersistentContext(profileDir(), {
    headless,
    executablePath: process.env.VINTED_CHROMIUM_PATH || undefined,
    proxy: proxyUrl ? toPlaywrightProxy(proxyUrl) : undefined,
    locale: 'en-US',
    viewport: { width: 1280, height: 860 },
  });
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    page.setDefaultTimeout(30_000);
    await page.goto(`https://${DOMAIN[country]}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
    return await fn({ country, page, context });
  } finally {
    await context.close().catch(() => {});
  }
}

/** Call Vinted's JSON API from inside the logged-in page. */
export async function api<T = any>(a: AccountPage, method: string, path: string, body?: unknown): Promise<ApiResponse<T>> {
  return a.page.evaluate(
    async ({ method, path, body }: { method: string; path: string; body?: unknown }) => {
      const csrf =
        document.querySelector<HTMLMetaElement>('meta[name="csrf-token"]')?.content ||
        (document.documentElement.innerHTML.match(/"CSRF_TOKEN\\?":\\?"([^"\\]+)/i) ?? [])[1];
      const anon = document.cookie.match(/(?:^|; )anon_id=([^;]+)/)?.[1];
      const headers: Record<string, string> = { Accept: 'application/json, text/plain, */*' };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (csrf) headers['X-CSRF-Token'] = csrf;
      if (anon) headers['X-Anon-Id'] = decodeURIComponent(anon);
      const r = await fetch(path, {
        method,
        headers,
        credentials: 'include',
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await r.text();
      try {
        return { status: r.status, json: JSON.parse(text) };
      } catch {
        return { status: r.status, text: text.slice(0, 300) };
      }
    },
    { method, path, body },
  );
}

export async function currentUserId(a: AccountPage): Promise<number | null> {
  const cookies: Array<{ name: string; value: string }> = await a.context.cookies(`https://${DOMAIN[a.country]}`);
  const uid = Number(cookies.find((c) => c.name === 'v_uid')?.value);
  if (Number.isSafeInteger(uid) && uid > 0) return uid;
  const r = await api(a, 'GET', '/api/v2/users/current');
  const id = Number(r.json?.user?.id);
  return r.status === 200 && Number.isSafeInteger(id) && id > 0 ? id : null;
}

export async function requireUserId(a: AccountPage): Promise<number> {
  const id = await currentUserId(a);
  if (!id) throw new Error('Not logged in to Vinted. Run account_login first and sign in in the browser window.');
  return id;
}

/** Open a visible window and wait for the seller to sign in themselves. */
export async function waitForLogin(a: AccountPage, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const id = await currentUserId(a).catch(() => null);
    if (id) return id;
    await a.page.waitForTimeout(2000);
  }
  throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for Vinted login.`);
}

const MIME: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.heic': 'image/heic',
};

/** Upload one photo the way the web form does; returns Vinted's photo ID. */
export async function uploadPhoto(a: AccountPage, file: string, tempUuid: string): Promise<number> {
  const data = (await readFile(file)).toString('base64');
  const r: ApiResponse = await a.page.evaluate(
    async ({ data, name, mime, tempUuid }: { data: string; name: string; mime: string; tempUuid: string }) => {
      const csrf =
        document.querySelector<HTMLMetaElement>('meta[name="csrf-token"]')?.content ||
        (document.documentElement.innerHTML.match(/"CSRF_TOKEN\\?":\\?"([^"\\]+)/i) ?? [])[1];
      const bytes = Uint8Array.from(atob(data), (ch) => ch.charCodeAt(0));
      const form = new FormData();
      form.append('photo[type]', 'item');
      form.append('photo[temp_uuid]', tempUuid);
      form.append('photo[file]', new Blob([bytes], { type: mime }), name);
      const headers: Record<string, string> = { Accept: 'application/json, text/plain, */*' };
      if (csrf) headers['X-CSRF-Token'] = csrf;
      const res = await fetch('/api/v2/photos', { method: 'POST', body: form, headers, credentials: 'include' });
      const text = await res.text();
      try {
        return { status: res.status, json: JSON.parse(text) };
      } catch {
        return { status: res.status, text: text.slice(0, 300) };
      }
    },
    { data, name: basename(file), mime: MIME[extname(file).toLowerCase()] ?? 'image/jpeg', tempUuid },
  );
  const id = Number(r.json?.id ?? r.json?.photo?.id);
  if (r.status >= 300 || !Number.isSafeInteger(id)) {
    throw new Error(`Photo upload failed for ${basename(file)} (HTTP ${r.status}): ${describe(r)}`);
  }
  return id;
}

export function describe(r: ApiResponse): string {
  const j = r.json;
  if (j?.errors) return JSON.stringify(j.errors).slice(0, 400);
  if (j?.message) return String(j.message);
  return r.text ?? JSON.stringify(j ?? {}).slice(0, 400);
}
