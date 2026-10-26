import 'dotenv/config';
import os from 'node:os';
import path from 'node:path';
import { launchPersistentContext } from 'cloakbrowser';
import type { BrowserContext, Page, Response } from 'playwright';

// ─── Configuration ────────────────────────────────────────────────────────────

export const DOMAIN = process.env.THREADS_DOMAIN || 'threads.com';
export const BASE_URL = `https://www.${DOMAIN}`;

export const PROFILE_DIR =
  process.env.THREADS_PROFILE_DIR || path.join(os.homedir(), '.threads-mcp', 'chrome-profile');

// Meta detects headless even with fingerprint patches, so we run HEADED by
// default (needs a display: WSLg, a desktop X server, or xvfb for servers).
// Set THREADS_HEADLESS=true only to experiment.
const HEADLESS = process.env.THREADS_HEADLESS === 'true';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export function debug(msg: string): void {
  if (process.env.DEBUG === 'true') process.stderr.write(`[threads-mcp] ${msg}\n`);
}

// ─── Context singleton ────────────────────────────────────────────────────────
//
// Threads' web app talks to Meta's Relay GraphQL gateway (/api/graphql) with
// per-session tokens (fb_dtsg, lsd) and anti-automation fingerprinting. Rather
// than hand-forge signed requests, we drive CloakBrowser (a fingerprint-patched
// Chromium) against a persistent profile the user logs into once (npm run
// login). READS intercept the GraphQL responses the app itself fires; WRITES
// drive the real composer/action UI so Meta's own client mints the tokens.

let contextPromise: Promise<BrowserContext> | null = null;

async function createContext(headless: boolean): Promise<BrowserContext> {
  debug(`Launching CloakBrowser (headless=${headless}) with profile: ${PROFILE_DIR}`);
  const ctx = (await launchPersistentContext({
    userDataDir: PROFILE_DIR,
    headless,
    userAgent: USER_AGENT,
    locale: 'en-US',
    timezone: 'Asia/Jakarta',
    viewport: { width: 1366, height: 900 },
    humanize: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })) as unknown as BrowserContext;
  return ctx;
}

/**
 * Get the shared browser context, launching it on first use.
 * `headless` overrides the env default (the login flow forces a visible window).
 */
export async function getContext(headless: boolean = HEADLESS): Promise<BrowserContext> {
  if (!contextPromise) contextPromise = createContext(headless);
  return contextPromise;
}

/** The single reused page. */
export async function getPage(): Promise<Page> {
  const ctx = await getContext();
  const existing = ctx.pages().find((p) => !p.isClosed());
  return existing ?? (await ctx.newPage());
}

// ─── Serialized navigation + interception ──────────────────────────────────────
//
// A single page is shared across tool calls; serialize access so overlapping
// calls don't clobber each other's navigation.

/**
 * Ceiling on any single locked operation. Generous — a media upload over a slow
 * link is legitimately slow — but finite, because the failure it prevents is
 * unbounded: the lock is a single chain, so one operation that never settles
 * blocks every future tool call for the lifetime of the process.
 */
const LOCK_TIMEOUT_MS = parseInt(process.env.THREADS_LOCK_TIMEOUT_MS ?? '120000', 10);

/** Close the shared page so the next getPage() builds a clean one. */
async function resetPage(): Promise<void> {
  try {
    const ctx = await contextPromise;
    for (const p of ctx?.pages() ?? []) if (!p.isClosed()) await p.close();
  } catch {
    /* nothing usable to reset — the next getPage() will rebuild anyway */
  }
}

let lock: Promise<unknown> = Promise.resolve();

/**
 * Serialize access to the shared page.
 *
 * The timeout does two things when it fires: it frees the queue, and it closes
 * the page out from under the stuck operation. That second part matters —
 * releasing the lock alone would let the next caller drive a page that a
 * half-finished navigation is still mutating. Closing it makes the orphan fail
 * fast instead of racing.
 */
export function withLock<T>(fn: () => Promise<T>, label = 'browser operation'): Promise<T> {
  const guarded = async (): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await new Promise<T>((resolve, reject) => {
        timer = setTimeout(() => {
          debug(`${label} exceeded ${LOCK_TIMEOUT_MS}ms — resetting the page`);
          void resetPage();
          reject(
            new Error(
              `${label} timed out after ${LOCK_TIMEOUT_MS}ms. The browser page was reset; ` +
                'retry, or raise THREADS_LOCK_TIMEOUT_MS if this is a slow upload.',
            ),
          );
        }, LOCK_TIMEOUT_MS);
        fn().then(resolve, reject);
      });
    } finally {
      clearTimeout(timer);
    }
  };
  const run = lock.then(guarded, guarded);
  lock = run.catch(() => {});
  return run;
}

/** What a trigger can ask the capture layer mid-run. */
export interface TriggerContext {
  /**
   * Has `BatchOptions.enough` been satisfied by what's landed so far? Lets a
   * scroll loop stop the moment it has the requested number of items instead
   * of running a fixed iteration count.
   */
  enough: () => boolean;
  /**
   * Discard everything captured so far — "the surface I want starts now".
   *
   * For a trigger that switches between surfaces sharing one response shape.
   * The Followers/Following dialog is the case in point: it opens on Followers
   * and loads them immediately, so after clicking through to Following the
   * capture holds both lists, both of them plain user objects with nothing to
   * tell them apart. Whichever landed first wins on document order, and
   * get_following would return followers.
   */
  reset: () => void;
}

export interface BatchOptions {
  /**
   * Preferred GraphQL operation, matched against the request's
   * `fb_api_req_friendly_name` (the app names every query), e.g.
   * "ProfileThreadsTab" or "PostPage". If seen, we stop dwelling early and
   * return it first — but we still collect every other GraphQL body, so a
   * drifted/renamed op degrades gracefully instead of timing out.
   */
  friendlyName?: string;
  /** How long to keep collecting responses after load/trigger (ms, default 3500). */
  dwellMs?: number;
  /** Navigation timeout (ms, default 30000). */
  timeoutMs?: number;
  /**
   * "Do we have what the caller asked for yet?" Checked against the bodies
   * collected so far, and the single biggest lever on read latency: satisfied
   * early, we stop dwelling immediately.
   *
   * Keep it cheap — it runs each poll tick (only when new bodies have arrived).
   */
  enough?: (bodies: unknown[]) => boolean;
  /**
   * May `trigger` be skipped entirely when `enough` is already satisfied by the
   * server-rendered payload?
   *
   * Only true for triggers that fetch *more of the same* data — scrolling a
   * feed for additional posts. It must stay false for a trigger that opens a
   * different surface (the followers dialog), because there the embedded
   * payload can satisfy a naive count with entirely the wrong records: a
   * profile page embeds post authors and recommendations, which are users, but
   * are not followers.
   *
   * Defaults to false so a new caller that forgets it loses the optimisation
   * rather than silently returning wrong data.
   */
  triggerSkippable?: boolean;
}

/** Pull `fb_api_req_friendly_name` out of a GraphQL POST body (form-encoded). */
function friendlyNameOf(postData: string | null): string | undefined {
  if (!postData) return undefined;
  const m = postData.match(/fb_api_req_friendly_name=([^&]+)/);
  return m ? decodeURIComponent(m[1]) : undefined;
}

/**
 * Parse a GraphQL response body. Meta usually returns a single JSON object, but
 * some streamed responses are newline-delimited JSON. Handle both; return every
 * object we could parse.
 */
function parseJsonBodies(txt: string): unknown[] {
  const trimmed = txt.trim();
  if (!trimmed) return [];
  try {
    return [JSON.parse(trimmed)];
  } catch {
    /* fall through to line-by-line */
  }
  const out: unknown[] = [];
  for (const line of trimmed.split('\n')) {
    const l = line.trim();
    if (!l) continue;
    try {
      out.push(JSON.parse(l));
    } catch {
      /* skip non-JSON chunk */
    }
  }
  return out;
}

/**
 * Threads server-renders profile/post/feed data into
 * `<script type="application/json">` blocks in the initial HTML — this is the
 * primary data source. The live GraphQL responses only cover lazy/secondary
 * queries (side-nav, scroll pagination).
 */
async function harvestEmbedded(page: Page, seen: Set<string>): Promise<unknown[]> {
  const out: unknown[] = [];
  try {
    const raws = await page.$$eval('script[type="application/json"]', (nodes) =>
      (nodes as Array<{ textContent: string | null }>).map((n) => n.textContent || ''),
    );
    for (const raw of raws) {
      if (raw.length < 40) continue;
      // Blocks are re-read after the trigger, so skip ones already parsed
      // rather than walking identical payloads twice.
      if (seen.has(raw)) continue;
      seen.add(raw);
      try {
        out.push(JSON.parse(raw));
      } catch {
        /* not standalone JSON — skip */
      }
    }
    debug(`harvested ${out.length} new embedded JSON blocks (${seen.size} seen)`);
  } catch {
    /* page may have navigated away — ignore */
  }
  return out;
}

/**
 * Navigate to `pageUrl` (optionally then run `trigger`) and collect the JSON
 * bodies of every `/api/graphql` response the app fires — the queries carry
 * valid fb_dtsg / lsd tokens. Returns all captured bodies, with any matching
 * `opts.friendlyName` first. Callers walk the bodies with defensive extractors,
 * so we don't depend on Meta keeping operation names stable.
 *
 * Ordering matters for latency. The embedded JSON is read straight after
 * navigation and checked against `opts.enough` *before* we scroll or dwell,
 * because the server-rendered payload usually already answers the request. The
 * previous order — dwell the full window, then harvest — paid several seconds
 * of fixed sleep for data that had been sitting in the HTML the whole time.
 */
export async function captureGraphqlBatch<T = unknown>(
  pageUrl: string,
  opts: BatchOptions = {},
  trigger?: (page: Page, ctx: TriggerContext) => Promise<void>,
): Promise<T[]> {
  const timeoutMs = opts.timeoutMs ?? 30000;
  const dwellMs = opts.dwellMs ?? 3500;

  return withLock(
    async () => {
      const page = await getPage();
      const collected: Array<{ name?: string; json: unknown }> = [];
      const pending: Array<Promise<void>> = [];
      // Accumulated across harvests. The blocks are read again after the trigger,
      // and React strips them from the DOM during hydration — so the later read
      // can legitimately return nothing. Replacing rather than accumulating threw
      // away the payload the whole optimisation depends on.
      const embedded: unknown[] = [];
      const seenBlocks = new Set<string>();

      const listener = (r: Response) => {
        // Threads uses two GraphQL endpoints: /api/graphql (profile/post surfaces)
        // AND /graphql/query (the home feed — BarcelonaFeedDirectQuery). Match both.
        if (!r.url().includes('graphql')) return;
        const name = friendlyNameOf(r.request().postData());
        if (process.env.DEBUG === 'true' && name) debug(`saw GraphQL: ${name}`);
        pending.push(
          r.text().then(
            (txt) => {
              for (const json of parseJsonBodies(txt)) collected.push({ name, json });
            },
            () => {},
          ),
        );
      };

      /** Bodies in priority order: embedded first, then the preferred op, then the rest. */
      const order = (): T[] => {
        const named = opts.friendlyName
          ? collected.filter((b) => b.name?.includes(opts.friendlyName!))
          : [];
        const rest = collected.filter((b) => !named.includes(b));
        return [...embedded, ...named.map((b) => b.json), ...rest.map((b) => b.json)] as T[];
      };

      /** Unconditional check — for triggers that ask at their own pace. */
      const isEnough = (): boolean => (opts.enough ? opts.enough(order() as unknown[]) : false);

      // Re-running the predicate on an unchanged body set just burns CPU, so the
      // poll loop only re-checks when something new has actually landed.
      let lastChecked = -1;
      const satisfied = (): boolean => {
        if (!opts.enough) return false;
        const n = embedded.length + collected.length;
        if (n === lastChecked) return false;
        lastChecked = n;
        return opts.enough(order() as unknown[]);
      };

      page.on('response', listener);
      try {
        // Always navigate. This used to be conditional when a trigger was
        // supplied — skipped when `page.url().startsWith(pageUrl)` — which is
        // wrong for any pageUrl that is a prefix of other pages. The home feed
        // is `https://www.threads.com/`, a prefix of *every* Threads URL, so
        // get_timeline never navigated: it scrolled whatever page the previous
        // tool call happened to leave behind and returned nothing.
        //
        // Reusing the loaded page saved one navigation at the cost of serving
        // another page's data. Not a trade worth making.
        await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });

        embedded.push(...(await harvestEmbedded(page, seenBlocks)));

        // The server-rendered payload often already covers the request. When it
        // does, skip the dwell — and the trigger too, but only when the caller
        // marked it skippable (see BatchOptions.triggerSkippable).
        const canSkipTrigger = !trigger || opts.triggerSkippable === true;
        if (canSkipTrigger && satisfied()) {
          debug('satisfied by embedded payload — skipping trigger and dwell');
        } else {
          if (trigger) {
            await trigger(page, {
              enough: isEnough,
              reset: () => {
                collected.length = 0;
                embedded.length = 0;
                seenBlocks.clear();
                lastChecked = -1;
                debug('trigger reset the capture buffer');
              },
            });
            // The trigger may have navigated or pulled in more server-rendered
            // content; add whatever is new, deduped by raw text.
            embedded.push(...(await harvestEmbedded(page, seenBlocks)));
            lastChecked = -1;
          }

          const deadline = Date.now() + dwellMs;
          while (Date.now() < deadline) {
            if (satisfied()) {
              debug('dwell satisfied early');
              break;
            }
            // Without a predicate, fall back to the old signal: the preferred
            // operation landing means the surface we wanted has responded.
            if (
              !opts.enough &&
              opts.friendlyName &&
              collected.some((b) => b.name?.includes(opts.friendlyName!))
            ) {
              await page.waitForTimeout(500); // let sibling queries land
              break;
            }
            await page.waitForTimeout(250);
          }
        }
      } finally {
        page.off('response', listener);
      }

      await Promise.allSettled(pending);
      return order();
    },
    `capture ${opts.friendlyName ?? pageUrl}`,
  );
}

/**
 * Run an arbitrary UI action on the shared page under the nav lock. Used by the
 * write tools (compose, like, follow, …) which drive Threads' real controls.
 */
export function onPage<T>(fn: (page: Page) => Promise<T>): Promise<T> {
  return withLock(async () => fn(await getPage()), 'page action');
}

/** Warm the session once (loads Threads so the app + tokens initialise). */
export async function warm(): Promise<void> {
  await withLock(async () => {
    const page = await getPage();
    if (!page.url().includes(DOMAIN)) {
      debug('Warming session on Threads home…');
      await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(2500);
    }
  }, 'warm session');
}

/** Best-effort check that the saved profile is logged in. */
export async function isLoggedIn(): Promise<boolean> {
  const ctx = await getContext();
  // Threads/Meta set `sessionid` and `ds_user_id` on the *.threads.com domain
  // (and on .instagram.com) once authenticated.
  const cookies = await ctx.cookies([BASE_URL, `https://${DOMAIN}`, 'https://www.instagram.com']);
  return cookies.some((c) => c.name === 'sessionid' && c.value.length > 8);
}

/** The logged-in user's numeric id, read from the `ds_user_id` cookie. */
export async function currentUserId(): Promise<string | undefined> {
  const ctx = await getContext();
  const cookies = await ctx.cookies([BASE_URL, `https://${DOMAIN}`, 'https://www.instagram.com']);
  return cookies.find((c) => c.name === 'ds_user_id')?.value;
}

let cachedHandle: string | undefined;

/**
 * Resolve the logged-in user's @handle by reading the Profile nav link on the
 * home page (its href is `/@handle`). Cached after first success.
 */
export async function resolveOwnHandle(): Promise<string | undefined> {
  if (cachedHandle) return cachedHandle;
  // An explicit account binding is the reliable option for headless sessions.
  // The home feed contains many profile links, none of which identifies us.
  const configured = process.env.THREADS_ACCOUNT_HANDLE?.replace(/^@/, '').trim();
  if (configured && /^[A-Za-z0-9._]+$/.test(configured)) {
    cachedHandle = configured;
    return configured;
  }
  return withLock(async () => {
    if (cachedHandle) return cachedHandle;
    const page = await getPage();
    if (!page.url().includes(DOMAIN)) {
      await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(2000);
    }
    // Only an explicitly labelled profile link can identify the account. Feed
    // author links must never become a fallback for write operations.
    const handle = await page
      .evaluate(() => {
        // Runs in the browser; `document` is the page DOM, not Node's global.
        const doc = (globalThis as { document?: unknown }).document as {
          querySelectorAll: (s: string) => ArrayLike<{ getAttribute(n: string): string | null }>;
        };
        const anchors = Array.from(doc.querySelectorAll('a[href^="/@"]'));
        const profile = anchors.find((a) => /profile/i.test(a.getAttribute('aria-label') || ''));
        const m = profile?.getAttribute('href')?.match(/^\/@([A-Za-z0-9._]+)/);
        return m ? m[1] : undefined;
      })
      .catch(() => undefined);
    if (handle) cachedHandle = handle;
    return handle;
  }, 'resolve own handle');
}

/** Cleanly close the browser (used on shutdown / after login). */
export async function closeContext(): Promise<void> {
  if (contextPromise) {
    const ctx = await contextPromise;
    await ctx.close();
    contextPromise = null;
  }
}
