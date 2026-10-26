import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Page } from 'playwright';
import { threadsUrl, normalizeHandle } from '../api/client.js';
import { BASE_URL, onPage, isLoggedIn } from '../browser/session.js';
import { withErrorHandling } from '../utils/errors.js';
import { invalidateAfterWrite } from '../utils/cache.js';
import { throttleWrite, markWriteComplete, rateLimitReminder } from '../utils/ratelimit.js';
import { WRITE_CREATES, WRITE_TOGGLES, WRITE_DESTRUCTIVE } from '../utils/annotations.js';
import { ThreadsAuthRequiredError, ThreadsAPIError } from '../api/client.js';

type TextResult = { content: Array<{ type: 'text'; text: string }> };

/**
 * Wrap a successful write result. Every write tool returns through here, which
 * makes it the one place guaranteed to run after a mutation — so it is also
 * where cached reads are dropped. Without this a `get_profile` immediately
 * after `create_thread` would serve the pre-post snapshot for up to CACHE_TTL_MS
 * and look like the post silently failed.
 */
function ok(text: string): TextResult {
  markWriteComplete();
  invalidateAfterWrite();
  return { content: [{ type: 'text', text: text + rateLimitReminder() }] };
}

// ─── Media handling ─────────────────────────────────────────────────────────────
//
// The composer exposes a hidden <input type="file" multiple> accepting
// image/{jpeg,png,webp,avif} and video/{mp4,quicktime,webm}. We feed it local
// files via setInputFiles; http(s) URLs are downloaded to a temp file first.

const EXT_BY_CT: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/avif': '.avif',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/webm': '.webm',
};

/** Ceiling on a downloaded media file. Threads itself rejects far smaller. */
const MAX_MEDIA_BYTES = parseInt(
  process.env.THREADS_MAX_MEDIA_BYTES ?? String(64 * 1024 * 1024),
  10,
);
/** How long a single media download may take before we give up. */
const MEDIA_TIMEOUT_MS = parseInt(process.env.THREADS_MEDIA_TIMEOUT_MS ?? '60000', 10);

/**
 * Download one remote media file to a temp path.
 *
 * Streamed with a running byte count rather than buffered via `arrayBuffer()`.
 * The old version accepted whatever the far end sent: no timeout, no size cap,
 * no type check — so a slow or hostile URL could hang the write lock until it
 * gave up, or read a multi-gigabyte response entirely into memory before
 * discovering Threads would reject it.
 */
async function downloadMedia(entry: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MEDIA_TIMEOUT_MS);
  try {
    let res: Response;
    try {
      res = await fetch(entry, { signal: controller.signal, redirect: 'follow' });
    } catch (e) {
      const why =
        e instanceof Error && e.name === 'AbortError'
          ? `timed out after ${MEDIA_TIMEOUT_MS}ms`
          : e instanceof Error
            ? e.message
            : String(e);
      throw new ThreadsAPIError(`Couldn't download media ${entry}: ${why}`, 200, 'media');
    }
    if (!res.ok)
      throw new ThreadsAPIError(
        `Couldn't download media ${entry} (HTTP ${res.status})`,
        200,
        'media',
      );

    const ct = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    // Catch the common failure of a URL that 200s with an HTML error/login page:
    // without this it lands on disk as ".jpg" and fails opaquely in the composer.
    if (ct && !/^(image|video)\//.test(ct)) {
      throw new ThreadsAPIError(
        `${entry} returned ${ct}, not an image or video. Threads only accepts ` +
          'images (jpg/png/webp/avif) and video (mp4/mov/webm).',
        200,
        'media',
      );
    }

    // Trust the declared length only to fail fast; the running count below is
    // what actually enforces the cap, since the header can lie or be absent.
    const declared = Number(res.headers.get('content-length') ?? '');
    if (Number.isFinite(declared) && declared > MAX_MEDIA_BYTES) {
      throw new ThreadsAPIError(
        `${entry} is ${(declared / 1048576).toFixed(1)}MB, over the ` +
          `${(MAX_MEDIA_BYTES / 1048576).toFixed(0)}MB limit (THREADS_MAX_MEDIA_BYTES).`,
        200,
        'media',
      );
    }

    const ext = EXT_BY_CT[ct] || path.extname(new URL(entry).pathname) || '.jpg';
    const tmp = path.join(
      os.tmpdir(),
      `threads-mcp-${crypto.randomBytes(6).toString('hex')}${ext}`,
    );

    const chunks: Buffer[] = [];
    let total = 0;
    const reader = res.body?.getReader();
    if (!reader) throw new ThreadsAPIError(`${entry} returned an empty body.`, 200, 'media');
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_MEDIA_BYTES) {
        await reader.cancel().catch(() => {});
        throw new ThreadsAPIError(
          `${entry} exceeded the ${(MAX_MEDIA_BYTES / 1048576).toFixed(0)}MB limit ` +
            'while downloading (THREADS_MAX_MEDIA_BYTES).',
          200,
          'media',
        );
      }
      chunks.push(Buffer.from(value));
    }
    fs.writeFileSync(tmp, Buffer.concat(chunks));
    return tmp;
  } finally {
    clearTimeout(timer);
  }
}

/** Resolve media entries (local paths or URLs) to absolute local file paths. */
export async function resolveMediaFiles(
  media: string[],
): Promise<{ paths: string[]; temps: string[] }> {
  const paths: string[] = [];
  const temps: string[] = [];
  try {
    for (const entry of media) {
      if (/^https?:\/\//i.test(entry)) {
        const tmp = await downloadMedia(entry);
        paths.push(tmp);
        temps.push(tmp);
      } else {
        const abs = path.resolve(entry.replace(/^~(?=\/|$)/, os.homedir()));
        if (!fs.existsSync(abs))
          throw new ThreadsAPIError(`Media file not found: ${entry}`, 200, 'media');
        const size = fs.statSync(abs).size;
        if (size > MAX_MEDIA_BYTES) {
          throw new ThreadsAPIError(
            `${entry} is ${(size / 1048576).toFixed(1)}MB, over the ` +
              `${(MAX_MEDIA_BYTES / 1048576).toFixed(0)}MB limit (THREADS_MAX_MEDIA_BYTES).`,
            200,
            'media',
          );
        }
        paths.push(abs);
      }
    }
  } catch (e) {
    // Don't strand temp files from earlier entries when a later one fails —
    // the caller's cleanup only runs for a list it successfully received.
    cleanupTemps(temps);
    throw e;
  }
  return { paths, temps };
}

/** DOM-click an <svg aria-label> icon's clickable ancestor (page-wide or scoped). */
async function clickSvgLabel(page: Page, label: string, scoped = true): Promise<boolean> {
  return page.evaluate(
    (args) => {
      const d = (globalThis as { document?: any }).document;
      const root = args.scoped ? d.querySelector('[aria-label="Column body"]') || d.body : d.body;
      const svg = root.querySelector('svg[aria-label="' + args.label + '"]');
      if (!svg) return false;
      let n = svg;
      while (n && !(n.getAttribute('role') === 'button' || n.tagName === 'BUTTON'))
        n = n.parentElement;
      (n || svg).click();
      return true;
    },
    { label, scoped },
  );
}

/**
 * Attach media to whichever composer is open. The dialog composer (new post)
 * already has a hidden <input type=file>; the inline reply composer creates the
 * picker only when "Attach media" is clicked, so we catch the filechooser event.
 * Then wait for the preview thumbnails to render.
 */
async function uploadMedia(page: Page, paths: string[]): Promise<void> {
  const existing = page.locator('input[type="file"]').first();
  if (await existing.count()) {
    await existing.setInputFiles(paths, { timeout: 20000 });
  } else {
    try {
      const [chooser] = await Promise.all([
        page.waitForEvent('filechooser', { timeout: 6000 }),
        clickSvgLabel(page, 'Attach media', false),
      ]);
      await chooser.setFiles(paths);
    } catch {
      const inp = page.locator('input[type="file"]').first();
      if (await inp.count()) await inp.setInputFiles(paths);
      else
        throw new ThreadsAPIError(
          'Could not open the media picker for this composer.',
          200,
          'media',
        );
    }
  }
  // Wait for previews (blob/data thumbnails or a <video>); video takes longer.
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    const ready = await page.evaluate(() => {
      const d = (globalThis as { document?: any }).document;
      return d.querySelectorAll('img[src^="blob:"],img[src^="data:"],video').length;
    });
    if (ready > 0) {
      await page.waitForTimeout(1200); // let all thumbnails settle
      return;
    }
    await page.waitForTimeout(600);
  }
}

/**
 * Delete any temp files we downloaded for a post.
 *
 * Synchronous on purpose. The callback form is fire-and-forget, so nothing
 * guarantees the unlink runs before the process moves on — and on the error
 * path, where the server may be shutting down or the caller may exit, the files
 * simply leaked into the temp directory.
 */
function cleanupTemps(temps: string[]): void {
  for (const t of temps) {
    try {
      fs.rmSync(t, { force: true });
    } catch {
      /* already gone, or not ours to remove */
    }
  }
}

async function requireLogin(): Promise<void> {
  if (!(await isLoggedIn())) throw new ThreadsAuthRequiredError('write');
}

/** Build a post-page URL from url OR handle+code. */
function postPageUrl(url?: string, handle?: string, code?: string): string | null {
  if (url) return url;
  if (code) {
    return handle
      ? threadsUrl(`/@${normalizeHandle(handle)}/post/${code}`)
      : threadsUrl(`/post/${code}`);
  }
  return null;
}

/**
 * Type `text` into the open composer dialog and submit it. Assumes a composer
 * dialog is already open on `page`. Returns when the Post button was clicked.
 */
async function fillAndSubmitComposer(
  page: Page,
  text: string,
  chain: string[] = [],
  beforeSubmit?: () => void,
): Promise<void> {
  // The composer is a dialog with a contenteditable body and a "Post" button.
  const dialog = page.locator('div[role="dialog"]').last();
  const editor = dialog.locator('[contenteditable="true"]').first();
  await editor.waitFor({ state: 'visible', timeout: 10000 });
  await editor.click();
  // Type with small delay to look human and to let the composer keep up.
  await page.keyboard.type(text, { delay: 15 });
  await page.waitForTimeout(700);

  // Each extra part is another post in the same chain. "Add to thread" appends
  // a fresh editor; the new one is always last in the dialog. The whole chain
  // is submitted by a single "Post" at the end — posting between parts would
  // publish them as unrelated standalone threads.
  for (const part of chain) {
    const add = dialog.getByRole('button', { name: /^add to thread$/i }).first();
    if (!(await add.count())) {
      throw new ThreadsAPIError(
        'Could not find the "Add to thread" control, so the chain would have posted ' +
          'as separate threads. Nothing was published.',
        200,
        'chain',
      );
    }
    await safeClick(add, 8000);
    await page.waitForTimeout(1000);
    const next = dialog.locator('[contenteditable="true"]').last();
    await next.waitFor({ state: 'visible', timeout: 8000 });
    await next.click();
    await page.keyboard.type(part, { delay: 15 });
    await page.waitForTimeout(600);
  }

  // The submit control is a "Post" button; it enables once there's text. The
  // anchored regex keeps this off "Post Options", which sits beside it.
  const postBtn = dialog.getByRole('button', { name: /^post$/i }).first();
  if (beforeSubmit) beforeSubmit();
  await safeClick(postBtn, 8000);
}

/**
 * The main post column. Threads renders the nav and the post in the same page,
 * so action buttons (Like/Repost/More/Reply) match multiple times — scope to the
 * "Column body" to hit the post's controls, not the nav's. Falls back to the
 * whole page if the landmark isn't present.
 */
function postColumn(page: Page) {
  const body = page.locator('[aria-label="Column body"]');
  return body;
}

/**
 * Meta occasionally injects a promo/confirm interstitial ("Continue", "Not now",
 * cookie/app prompts) that overlays the post and swallows action clicks. Dismiss
 * any such dialog before we act. Best-effort and silent.
 */
async function dismissInterstitial(page: Page): Promise<void> {
  for (const name of [/^not now$/i, /^continue$/i, /^close$/i, /^dismiss$/i, /^allow all/i]) {
    const btn = page.getByRole('button', { name }).first();
    if (await btn.count().catch(() => 0)) {
      await domClick(btn, 2500).catch(() => {});
      await page.waitForTimeout(600);
    }
  }
}

/**
 * Robust click. CloakBrowser's `humanize` can mis-pass Playwright's click
 * timeout (surfaces as a bogus "Timeout 1ms exceeded") when an element isn't
 * instantly actionable — so we wait for visibility first, then click, then fall
 * back to a forced click. Avoids `.or()` compounds, which trigger the same bug.
 */
async function safeClick(locator: ReturnType<Page['locator']>, timeout = 10000): Promise<void> {
  await locator.waitFor({ state: 'visible', timeout });
  await locator.page().waitForTimeout(300);
  try {
    await locator.click({ timeout });
  } catch {
    await locator.click({ force: true, timeout });
  }
}

/**
 * Click an action button (Like/Repost/More…) by accessible name, scoped to the
 * post column. These are small icon buttons where CloakBrowser's humanized
 * pointer click lands off-target and never fires React's onClick — so we resolve
 * the element and invoke a DOM-level `.click()`, which does trigger the handler.
 */
async function domClick(loc: ReturnType<Page['locator']>, timeout = 10000): Promise<boolean> {
  if (!(await loc.count())) return false;
  await loc.waitFor({ state: 'visible', timeout });
  await loc.page().waitForTimeout(200);
  const handle = await loc.elementHandle();
  if (!handle) return false;
  await handle.evaluate((el) => (el as unknown as { click(): void }).click());
  await handle.dispose();
  return true;
}

async function clickAction(page: Page, name: string, timeout = 10000): Promise<void> {
  // These controls are an <svg aria-label="…"> whose *ancestor* carries the
  // click handler — clicking the svg itself often no-ops. Resolve the labelled
  // svg inside the post column and invoke a DOM click on its button ancestor.
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const clicked = await page.evaluate((label) => {
      // Runs in the browser; use `any` since the TS DOM lib isn't loaded here.
      const d = (globalThis as { document?: any }).document;
      const body = d.querySelector('[aria-label="Column body"]') || d.body;
      const svg = body && body.querySelector('svg[aria-label="' + label + '"]');
      if (!svg) return false;
      let n = svg;
      while (n && !(n.getAttribute('role') === 'button' || n.tagName === 'BUTTON'))
        n = n.parentElement;
      (n || svg).click();
      return true;
    }, name);
    if (clicked) return;
    await page.waitForTimeout(400);
  }
  // Fallback to locator-based clicks if the svg never appeared.
  const col = postColumn(page);
  let loc = col.getByRole('button', { name }).first();
  if (!(await loc.count())) loc = page.getByLabel(name).first();
  if (!(await loc.count())) loc = page.getByRole('button', { name }).first();
  if (!(await domClick(loc, 5000))) await safeClick(loc, 5000);
}

/**
 * Find, inside any open popup (`role=menu`/`role=dialog`, else the whole page), a
 * visible element whose exact text matches `re`, and DOM-click its nearest
 * clickable ancestor. Used for menu options (Repost / Remove / Unfollow …) that
 * Threads renders without stable menuitem/button roles.
 */
async function clickPopupOption(page: Page, re: RegExp): Promise<boolean> {
  return page.evaluate(
    (src) => {
      const rx = new RegExp(src.source, src.flags);
      const d = (globalThis as { document?: any }).document;
      const vis = (el: any) => el.offsetParent !== null || el.getClientRects().length > 0;
      const scopes = Array.from(d.querySelectorAll('[role="menu"],[role="dialog"]'));
      const roots = scopes.length ? scopes : [d.body];
      for (const root of roots as any[]) {
        for (const el of Array.from(root.querySelectorAll('*')) as any[]) {
          const t = (el.textContent || '').trim();
          if (rx.test(t) && t.length <= 18 && vis(el)) {
            let n = el;
            while (
              n &&
              !(
                n.getAttribute &&
                (n.getAttribute('role') === 'button' ||
                  n.getAttribute('role') === 'menuitem' ||
                  n.tagName === 'BUTTON' ||
                  (n.tabIndex !== undefined && n.tabIndex >= 0))
              )
            )
              n = n.parentElement;
            (n || el).click();
            return true;
          }
        }
      }
      return false;
    },
    { source: re.source, flags: re.flags },
  );
}

/** Best-effort: wait for the composer dialog to close (a proxy for "sent"). */
async function waitComposerClosed(page: Page): Promise<boolean> {
  try {
    await page.locator('div[role="dialog"] [contenteditable="true"]').first().waitFor({
      state: 'detached',
      timeout: 12000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Compose and publish a new thread (text and/or media). Shared by the
 * `create_thread` tool and the scheduler. Returns a human-readable result and
 * throws on hard failures (login/media). Does its own rate-limit throttling.
 */
export async function publishThread(opts: {
  text?: string;
  media?: string[];
  chain?: string[];
  beforeSubmit?: () => void;
}): Promise<string> {
  const { text, media } = opts;
  const chain = (opts.chain ?? []).filter((c) => c.trim().length > 0);
  if (!text && !(media && media.length)) {
    throw new ThreadsAPIError('Provide text, media, or both.', 200, 'publish');
  }
  if (chain.length && !text) {
    // The chain hangs off the first post, so there has to be one.
    throw new ThreadsAPIError('`chain` needs `text` for the first post.', 200, 'publish');
  }
  await requireLogin();
  const { paths, temps } =
    media && media.length ? await resolveMediaFiles(media) : { paths: [], temps: [] };
  await throttleWrite();
  try {
    return await onPage(async (page) => {
      await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(1500);
      await dismissInterstitial(page);

      // Open the composer. Try, in order: the "What's new?" placeholder, the
      // "New thread" button, the "Create" control.
      const openers = [
        page.getByText(/what's new\?|start a thread/i).first(),
        page.getByRole('button', { name: /new thread/i }).first(),
        page.getByLabel('Create').first(),
      ];
      for (const o of openers) {
        if (await o.count()) {
          try {
            await safeClick(o, 8000);
            break;
          } catch {
            /* try next opener */
          }
        }
      }
      await page.waitForTimeout(1000);

      if (paths.length) await uploadMedia(page, paths);
      await fillAndSubmitComposer(page, text ?? '', chain, opts.beforeSubmit);
      const closed = await waitComposerClosed(page);

      const what =
        (paths.length ? `${text ? `"${text}" + ` : ''}${paths.length} media` : `"${text}"`) +
        (chain.length ? ` (+${chain.length} more in the chain)` : '');
      // The scheduler calls publishThread directly, bypassing ok(), so close
      // out the write here too.
      markWriteComplete();
      invalidateAfterWrite();
      return closed
        ? `✅ Posted to Threads: ${what}`
        : `📤 Submitted the post (${what}), but couldn't confirm the composer closed. Check your profile.`;
    });
  } finally {
    cleanupTemps(temps);
  }
}

/** Text-only reply path shared with the durable send tools. */
export async function publishTextReply(opts: {
  target: string;
  text: string;
  beforeSubmit?: () => void;
}): Promise<string> {
  if (!opts.text.trim() || opts.text.length > 500) {
    throw new ThreadsAPIError('Reply text must contain 1–500 characters.', 200, 'reply');
  }
  await requireLogin();
  await throttleWrite();
  return onPage(async (page) => {
    await page.goto(opts.target, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(1800);
    await dismissInterstitial(page);
    const author = opts.target.match(/\/@([A-Za-z0-9._]+)\/post\//)?.[1];
    if (!author) throw new ThreadsAPIError('Reply target must include its author.', 200, 'reply');
    const editor = page.locator(
      `[contenteditable="true"][aria-placeholder="Reply to ${author}..."]`,
    );
    await editor.first().waitFor({ state: 'visible', timeout: 10000 });
    if ((await editor.count()) !== 1) {
      throw new ThreadsAPIError('Could not identify the target reply editor.', 200, 'reply');
    }
    const expand = page.locator('[aria-label="Expand composer"]');
    if ((await expand.count()) !== 1 || !(await expand.isVisible())) {
      throw new ThreadsAPIError('Could not identify the reply composer.', 200, 'reply');
    }
    await expand.click({ timeout: 10000, noWaitAfter: true });
    const deadline = Date.now() + 10000;
    let activePage: Page | undefined;
    let dialog: ReturnType<Page['locator']> | undefined;
    while (Date.now() < deadline) {
      const matches = [];
      for (const candidate of page.context().pages()) {
        if (candidate.isClosed() || !candidate.url().startsWith(BASE_URL)) continue;
        const panel = candidate.locator('[role="dialog"]:has([contenteditable="true"])');
        if ((await panel.count()) === 1) matches.push({ candidate, panel });
      }
      if (matches.length > 1) {
        throw new ThreadsAPIError('More than one reply composer is open.', 200, 'reply');
      }
      if (matches.length === 1) {
        activePage = matches[0].candidate;
        dialog = matches[0].panel;
        break;
      }
      await page.waitForTimeout(200);
    }
    if (!activePage || !dialog) {
      throw new ThreadsAPIError('Reply composer did not open.', 200, 'reply');
    }
    const body = dialog.locator('[contenteditable="true"]');
    if ((await body.count()) !== 1 || (await body.innerText()).trim()) {
      throw new ThreadsAPIError('Reply composer is ambiguous or already filled.', 200, 'reply');
    }
    await body.fill(opts.text);
    if ((await body.innerText()) !== opts.text) {
      throw new ThreadsAPIError('Reply editor did not contain the exact text.', 200, 'reply');
    }
    const submit = dialog.getByRole('button', { name: /^post$/i });
    if ((await submit.count()) !== 1 || !(await submit.isEnabled())) {
      throw new ThreadsAPIError('Reply submit control is unavailable.', 200, 'reply');
    }
    if (opts.beforeSubmit) opts.beforeSubmit();
    await submit.click({ timeout: 10000, noWaitAfter: true });
    await activePage.waitForTimeout(1500);
    markWriteComplete();
    invalidateAfterWrite();
    return 'Reply submitted; inspect the provider receipt to confirm publication.';
  });
}

export function registerWriteTools(server: McpServer): void {
  // ── create_thread ──────────────────────────────────────────────────────────────
  server.registerTool(
    'create_thread',
    {
      title: 'Post a thread',
      description:
        'Post a new thread to YOUR Threads account — text and/or media (images & video). ⚠️ Real account — ' +
        'use sparingly; the server enforces a minimum gap between writes to avoid rate-limit/automation flags.',
      inputSchema: {
        text: z
          .string()
          .max(500)
          .optional()
          .describe('The post text (max 500 chars). Optional if media is given.'),
        media: z
          .array(z.string())
          .max(20)
          .optional()
          .describe(
            'Local file paths and/or http(s) URLs to attach. Images (jpg/png/webp/avif) and/or video ' +
              '(mp4/mov/webm). Multiple images post as a carousel. Optional if text is given.',
          ),
        chain: z
          .array(z.string().max(500))
          .max(24)
          .optional()
          .describe(
            'Additional posts to publish as one connected thread, in order, after `text`. ' +
              'This is the multi-post format Threads calls "Add to thread" — the parts stay ' +
              'linked. Posting them one at a time instead produces unlinked standalone threads.',
          ),
      },
      annotations: WRITE_CREATES,
    },
    async ({ text, media, chain }) => {
      return withErrorHandling(async () => ok(await publishThread({ text, media, chain })));
    },
  );

  // ── reply_to_thread ────────────────────────────────────────────────────────────
  server.registerTool(
    'reply_to_thread',
    {
      title: 'Reply to a post',
      description:
        'Reply to a Threads post with text and/or media. Provide the post `url`, or `handle` + `code`. ' +
        '⚠️ Real account — rate-limited.',
      inputSchema: {
        text: z
          .string()
          .max(500)
          .optional()
          .describe('Your reply text (max 500 chars). Optional if media is given.'),
        media: z
          .array(z.string())
          .max(20)
          .optional()
          .describe(
            'Local file paths and/or http(s) URLs — images (jpg/png/webp/avif) and/or video (mp4/mov/webm).',
          ),
        url: z.string().optional().describe('Full post URL to reply to'),
        handle: z.string().optional().describe('Author @username (if not using url)'),
        code: z.string().optional().describe('Post shortcode (if not using url)'),
      },
      annotations: WRITE_CREATES,
    },
    async ({ text, media, url, handle, code }) => {
      return withErrorHandling(async () => {
        await requireLogin();
        const target = postPageUrl(url, handle, code);
        if (!target)
          return {
            content: [{ type: 'text', text: '❌ Provide a post `url`, or `handle` + `code`.' }],
          };
        if (!text && !(media && media.length)) {
          return {
            content: [{ type: 'text', text: '❌ Provide reply `text`, `media`, or both.' }],
          };
        }
        const { paths, temps } =
          media && media.length ? await resolveMediaFiles(media) : { paths: [], temps: [] };
        await throttleWrite();
        try {
          return await onPage(async (page) => {
            await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 45000 });
            await page.waitForTimeout(1800);
            await dismissInterstitial(page);

            // The post page has an inline "Reply to …" composer already present.
            const editor = page.locator('[contenteditable="true"]').first();
            await editor.waitFor({ state: 'visible', timeout: 10000 });
            await editor.click();
            await page.waitForTimeout(400);
            const what = paths.length
              ? `${text ? `"${text}" + ` : ''}${paths.length} media`
              : `"${text}"`;

            if (paths.length) {
              // Media needs the full dialog composer (it has a real <input type=file>
              // and a Post button). "Expand composer" promotes the inline box to it.
              await clickSvgLabel(page, 'Expand composer', true);
              await page
                .locator('div[role="dialog"]')
                .last()
                .waitFor({ state: 'visible', timeout: 8000 });
              await page.waitForTimeout(800);
              await uploadMedia(page, paths);
              await fillAndSubmitComposer(page, text ?? '');
              const closed = await waitComposerClosed(page);
              return ok(
                closed
                  ? `✅ Replied: ${what}\n\n↳ on ${target}`
                  : `📤 Submitted the reply (${what}), but couldn't confirm it sent. Check the post to verify.`,
              );
            }

            // Text-only: type and submit with the Ctrl/Cmd+Enter shortcut (no
            // visible Post button in the inline composer).
            await page.keyboard.type(text ?? '', { delay: 15 });
            await page.waitForTimeout(700);
            await page.keyboard.press('Control+Enter');
            await page.waitForTimeout(2500);
            const remaining = (await editor.innerText().catch(() => '')).trim();
            const probe = (text ?? '').slice(0, 12);
            const sent = remaining.length === 0 || (probe.length > 0 && !remaining.includes(probe));
            return ok(
              sent
                ? `✅ Replied: ${what}\n\n↳ on ${target}`
                : `📤 Submitted the reply (${what}), but couldn't confirm it sent. Check the post to verify.`,
            );
          });
        } finally {
          cleanupTemps(temps);
        }
      });
    },
  );

  // ── like_thread ────────────────────────────────────────────────────────────────
  server.registerTool(
    'like_thread',
    {
      title: 'Like a post',
      description:
        'Like a Threads post. Provide the post `url`, or `handle` + `code`. ⚠️ Real account — rate-limited.',
      inputSchema: {
        url: z.string().optional().describe('Full post URL'),
        handle: z.string().optional().describe('Author @username (if not using url)'),
        code: z.string().optional().describe('Post shortcode (if not using url)'),
      },
      annotations: WRITE_TOGGLES,
    },
    async ({ url, handle, code }) => {
      return withErrorHandling(async () => {
        await requireLogin();
        const target = postPageUrl(url, handle, code);
        if (!target)
          return {
            content: [{ type: 'text', text: '❌ Provide a post `url`, or `handle` + `code`.' }],
          };
        await throttleWrite();
        return onPage(async (page) => {
          await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 45000 });
          await page.waitForTimeout(1500);
          await dismissInterstitial(page);
          const col = postColumn(page);
          if (await col.getByRole('button', { name: 'Unlike' }).first().count()) {
            return ok('👍 Already liked.');
          }
          if (!(await col.getByRole('button', { name: 'Like' }).first().count())) {
            throw new ThreadsAPIError('Could not find the Like control on that post.', 200, 'like');
          }
          await clickAction(page, 'Like', 8000);
          await page.waitForTimeout(1200);
          const liked = (await col.getByRole('button', { name: 'Unlike' }).first().count()) > 0;
          return ok(
            liked ? `❤️ Liked ${target}` : `📤 Tapped like on ${target} (couldn't confirm state).`,
          );
        });
      });
    },
  );

  // ── repost_thread ──────────────────────────────────────────────────────────────
  server.registerTool(
    'repost_thread',
    {
      title: 'Repost a post',
      description:
        'Repost a Threads post to your followers. Provide the post `url`, or `handle` + `code`. ' +
        '⚠️ Real account — rate-limited.',
      inputSchema: {
        url: z.string().optional().describe('Full post URL'),
        handle: z.string().optional().describe('Author @username (if not using url)'),
        code: z.string().optional().describe('Post shortcode (if not using url)'),
      },
      annotations: WRITE_TOGGLES,
    },
    async ({ url, handle, code }) => {
      return withErrorHandling(async () => {
        await requireLogin();
        const target = postPageUrl(url, handle, code);
        if (!target)
          return {
            content: [{ type: 'text', text: '❌ Provide a post `url`, or `handle` + `code`.' }],
          };
        await throttleWrite();
        return onPage(async (page) => {
          await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 45000 });
          await page.waitForTimeout(1500);
          await dismissInterstitial(page);
          // The repost icon opens a menu (Repost / Quote); pick "Repost". After
          // the menu opens there are two controls named "Repost" — the icon we
          // just clicked and the menu item — so target the menu item (the last
          // visible one), trying menuitem then button role.
          await clickAction(page, 'Repost', 10000);
          await page.waitForTimeout(1200);
          // The menu's "Repost" option isn't a stable menuitem/button role, so
          // search the open popup for a visible "Repost" and click it.
          const picked = await clickPopupOption(page, /^repost$/i);
          if (!picked) {
            throw new ThreadsAPIError(
              'Opened the repost control but could not find the "Repost" confirm option. ' +
                'Meta may have changed the menu; try again shortly.',
              200,
              'repost',
            );
          }
          await page.waitForTimeout(1200);
          return ok(
            `🔁 Reposted ${target}\n\n_(Note: Threads treats reposting your own post as a no-op.)_`,
          );
        });
      });
    },
  );

  // ── quote_thread ────────────────────────────────────────────────────────────────
  server.registerTool(
    'quote_thread',
    {
      title: 'Quote a post',
      description:
        'Quote-post a Threads post — repost it with your own comment (text and/or media). Provide the post ' +
        '`url`, or `handle` + `code`, plus your `text` and/or `media`. ⚠️ Real account — rate-limited.',
      inputSchema: {
        text: z
          .string()
          .max(500)
          .optional()
          .describe('Your comment on the quoted post (max 500 chars).'),
        media: z
          .array(z.string())
          .max(20)
          .optional()
          .describe('Local file paths and/or http(s) URLs to attach to your quote.'),
        url: z.string().optional().describe('Full URL of the post to quote'),
        handle: z.string().optional().describe('Author @username (if not using url)'),
        code: z.string().optional().describe('Post shortcode (if not using url)'),
      },
      annotations: WRITE_CREATES,
    },
    async ({ text, media, url, handle, code }) => {
      return withErrorHandling(async () => {
        await requireLogin();
        const target = postPageUrl(url, handle, code);
        if (!target)
          return {
            content: [{ type: 'text', text: '❌ Provide a post `url`, or `handle` + `code`.' }],
          };
        if (!text && !(media && media.length)) {
          return {
            content: [{ type: 'text', text: '❌ Provide `text`, `media`, or both for the quote.' }],
          };
        }
        const { paths, temps } =
          media && media.length ? await resolveMediaFiles(media) : { paths: [], temps: [] };
        await throttleWrite();
        try {
          return await onPage(async (page) => {
            await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 45000 });
            await page.waitForTimeout(1500);
            await dismissInterstitial(page);
            // Open the repost menu and choose "Quote" — this opens the composer
            // dialog with the target post embedded as a quote.
            await clickAction(page, 'Repost', 10000);
            await page.waitForTimeout(1200);
            const picked = await clickPopupOption(page, /^quote$/i);
            if (!picked) {
              throw new ThreadsAPIError(
                'Opened the repost control but could not find the "Quote" option.',
                200,
                'quote',
              );
            }
            await page
              .locator('div[role="dialog"]')
              .last()
              .waitFor({ state: 'visible', timeout: 10000 });
            await page.waitForTimeout(900);
            if (paths.length) await uploadMedia(page, paths);
            await fillAndSubmitComposer(page, text ?? '');
            const closed = await waitComposerClosed(page);
            const what = paths.length
              ? `${text ? `"${text}" + ` : ''}${paths.length} media`
              : `"${text}"`;
            return ok(
              closed
                ? `❝ Quoted ${target}\n\nwith: ${what}`
                : `📤 Submitted the quote (${what}) of ${target}, but couldn't confirm it sent. Check your profile.`,
            );
          });
        } finally {
          cleanupTemps(temps);
        }
      });
    },
  );

  // ── follow_user ────────────────────────────────────────────────────────────────
  server.registerTool(
    'follow_user',
    {
      title: 'Follow a user',
      description:
        'Follow a Threads user by @handle. ⚠️ Real account — follow/unfollow bursts are a classic ban ' +
        'trigger, so this is rate-limited.',
      inputSchema: {
        handle: z.string().describe('The @username to follow'),
      },
      annotations: WRITE_TOGGLES,
    },
    async ({ handle }) => {
      return withErrorHandling(async () => {
        await requireLogin();
        const user = normalizeHandle(handle);
        await throttleWrite();
        return onPage(async (page) => {
          await page.goto(threadsUrl(`/@${user}`), {
            waitUntil: 'domcontentloaded',
            timeout: 45000,
          });
          await page.waitForTimeout(1500);
          await dismissInterstitial(page);
          const alreadyFollowing = await page
            .getByRole('button', { name: /^following$/i })
            .first()
            .count();
          if (alreadyFollowing) return ok(`✅ Already following @${user}.`);
          const followBtn = page.getByRole('button', { name: /^follow$/i }).first();
          if (!(await followBtn.count())) {
            throw new ThreadsAPIError(
              `Couldn't find a Follow button on @${user}'s profile.`,
              200,
              'follow',
            );
          }
          if (!(await domClick(followBtn, 8000))) await safeClick(followBtn, 8000);
          await page.waitForTimeout(1200);
          const nowFollowing =
            (await page
              .getByRole('button', { name: /^following$/i })
              .first()
              .count()) > 0;
          return ok(
            nowFollowing
              ? `➕ Now following @${user}.`
              : `📤 Tapped Follow on @${user} (couldn't confirm).`,
          );
        });
      });
    },
  );

  // ── delete_thread ──────────────────────────────────────────────────────────────
  server.registerTool(
    'delete_thread',
    {
      title: 'Delete a post',
      description:
        'Delete one of YOUR OWN Threads posts. Provide the post `url`, or `handle` + `code`. This is permanent.',
      inputSchema: {
        url: z.string().optional().describe('Full post URL (must be your own post)'),
        handle: z.string().optional().describe('Your @username (if not using url)'),
        code: z.string().optional().describe('Post shortcode (if not using url)'),
      },
      annotations: WRITE_DESTRUCTIVE,
    },
    async ({ url, handle, code }) => {
      return withErrorHandling(async () => {
        await requireLogin();
        const target = postPageUrl(url, handle, code);
        if (!target)
          return {
            content: [{ type: 'text', text: '❌ Provide a post `url`, or `handle` + `code`.' }],
          };
        await throttleWrite();
        return onPage(async (page) => {
          await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 45000 });
          await page.waitForTimeout(1500);
          await dismissInterstitial(page);
          // Open the post's "More" menu (scoped to the post, not the nav),
          // then Delete, then confirm.
          await clickAction(page, 'More', 10000);
          await page.waitForTimeout(800);
          const del = page.getByRole('menuitem', { name: /delete/i }).first();
          await del.click({ timeout: 6000 });
          await page.waitForTimeout(800);
          const confirm = page.getByRole('button', { name: /^delete$/i }).first();
          await confirm.click({ timeout: 6000 }).catch(() => {});
          await page.waitForTimeout(1500);
          return ok(`🗑 Deleted the post (${target}).`);
        });
      });
    },
  );

  // ── unlike_thread ──────────────────────────────────────────────────────────────
  server.registerTool(
    'unlike_thread',
    {
      title: 'Unlike a post',
      description:
        'Remove your like from a Threads post. Provide the post `url`, or `handle` + `code`. ⚠️ Real account — rate-limited.',
      inputSchema: {
        url: z.string().optional().describe('Full post URL'),
        handle: z.string().optional().describe('Author @username (if not using url)'),
        code: z.string().optional().describe('Post shortcode (if not using url)'),
      },
      annotations: WRITE_TOGGLES,
    },
    async ({ url, handle, code }) => {
      return withErrorHandling(async () => {
        await requireLogin();
        const target = postPageUrl(url, handle, code);
        if (!target)
          return {
            content: [{ type: 'text', text: '❌ Provide a post `url`, or `handle` + `code`.' }],
          };
        await throttleWrite();
        return onPage(async (page) => {
          await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 45000 });
          await page.waitForTimeout(1500);
          await dismissInterstitial(page);
          const col = postColumn(page);
          if (!(await col.getByRole('button', { name: 'Unlike' }).first().count())) {
            return ok('👍 Post is not liked — nothing to undo.');
          }
          await clickAction(page, 'Unlike', 8000);
          await page.waitForTimeout(1200);
          const cleared = (await col.getByRole('button', { name: 'Like' }).first().count()) > 0;
          return ok(
            cleared
              ? `💔 Removed like on ${target}`
              : `📤 Tapped unlike on ${target} (couldn't confirm state).`,
          );
        });
      });
    },
  );

  // ── unrepost_thread ──────────────────────────────────────────────────────────────
  server.registerTool(
    'unrepost_thread',
    {
      title: 'Remove a repost',
      description:
        'Remove your repost of a Threads post. Provide the post `url`, or `handle` + `code`. ⚠️ Real account — rate-limited.',
      inputSchema: {
        url: z.string().optional().describe('Full post URL'),
        handle: z.string().optional().describe('Author @username (if not using url)'),
        code: z.string().optional().describe('Post shortcode (if not using url)'),
      },
      annotations: WRITE_TOGGLES,
    },
    async ({ url, handle, code }) => {
      return withErrorHandling(async () => {
        await requireLogin();
        const target = postPageUrl(url, handle, code);
        if (!target)
          return {
            content: [{ type: 'text', text: '❌ Provide a post `url`, or `handle` + `code`.' }],
          };
        await throttleWrite();
        return onPage(async (page) => {
          await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 45000 });
          await page.waitForTimeout(1500);
          await dismissInterstitial(page);
          // Open the repost menu; when already reposted it offers "Remove".
          await clickAction(page, 'Repost', 10000);
          await page.waitForTimeout(1200);
          const removed = await clickPopupOption(page, /^(remove|unpost|remove repost)$/i);
          if (!removed) {
            // Menu had no "Remove" — the post likely wasn't reposted. Close menu.
            await page.keyboard.press('Escape').catch(() => {});
            return ok('🔁 Post is not reposted — nothing to undo.');
          }
          await page.waitForTimeout(1200);
          return ok(`↩️ Removed repost of ${target}`);
        });
      });
    },
  );

  // ── unfollow_user ────────────────────────────────────────────────────────────────
  server.registerTool(
    'unfollow_user',
    {
      title: 'Unfollow a user',
      description:
        'Unfollow a Threads user by @handle. ⚠️ Real account — follow/unfollow bursts are a classic ban ' +
        'trigger, so this is rate-limited.',
      inputSchema: {
        handle: z.string().describe('The @username to unfollow'),
      },
      annotations: WRITE_TOGGLES,
    },
    async ({ handle }) => {
      return withErrorHandling(async () => {
        await requireLogin();
        const user = normalizeHandle(handle);
        await throttleWrite();
        return onPage(async (page) => {
          await page.goto(threadsUrl(`/@${user}`), {
            waitUntil: 'domcontentloaded',
            timeout: 45000,
          });
          await page.waitForTimeout(1500);
          await dismissInterstitial(page);
          const following = page.getByRole('button', { name: /^following$/i }).first();
          if (!(await following.count())) {
            return ok(`✅ Not following @${user} — nothing to undo.`);
          }
          await domClick(following, 8000);
          await page.waitForTimeout(1000);
          // Confirm in the menu/dialog that appears.
          const confirmed = await clickPopupOption(page, /^unfollow$/i);
          if (!confirmed)
            await domClick(page.getByRole('button', { name: /^unfollow$/i }).first(), 5000);
          await page.waitForTimeout(1200);
          const done =
            (await page
              .getByRole('button', { name: /^follow$/i })
              .first()
              .count()) > 0;
          return ok(
            done ? `➖ Unfollowed @${user}.` : `📤 Tapped Unfollow on @${user} (couldn't confirm).`,
          );
        });
      });
    },
  );
}
