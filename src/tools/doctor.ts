import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Page } from 'playwright';
import { BASE_URL, onPage, isLoggedIn, resolveOwnHandle } from '../browser/session.js';
import { ANCHORS, type Anchor } from '../browser/selectors.js';
import { threadsCapture, threadsUrl, profileUrl } from '../api/client.js';
import { extractPosts, extractActivity } from '../api/extract.js';
import { withErrorHandling } from '../utils/errors.js';
import { READ } from '../utils/annotations.js';

const CheckSchema = z.object({
  id: z.string(),
  ok: z.boolean(),
  detail: z.string(),
  breaks: z.string().optional().describe('What stops working when this fails'),
});

type Check = z.infer<typeof CheckSchema>;

/** Is an anchor present on the page right now? */
async function anchorPresent(page: Page, a: Anchor): Promise<boolean> {
  if (a.css) {
    const n = await page
      .evaluate((sel) => {
        const d = (globalThis as { document?: any }).document;
        return d.querySelectorAll(sel).length;
      }, a.css)
      .catch(() => 0);
    if (n > 0) return true;
  }
  if (a.text) {
    const n = await page
      .getByText(a.text)
      .first()
      .count()
      .catch(() => 0);
    if (n > 0) return true;
    const b = await page
      .getByRole('button', { name: a.text })
      .first()
      .count()
      .catch(() => 0);
    if (b > 0) return true;
  }
  return false;
}

/**
 * Open the composer, check its anchors, and close it without leaving anything
 * behind. Escaping a composer with content prompts "Save to drafts?", so the
 * prompt is answered explicitly — a health check must not accumulate drafts on
 * the user's account.
 */
async function checkComposer(page: Page, out: Check[]): Promise<void> {
  const openers = [
    page.getByText(/what['’]s new\?|start a thread/i).first(),
    page.getByRole('button', { name: /new thread/i }).first(),
  ];
  for (const o of openers) {
    if (await o.count().catch(() => 0)) {
      await o.click({ timeout: 8000 }).catch(() => {});
      break;
    }
  }
  await page.waitForTimeout(2000);
  const opened = await page
    .locator('div[role="dialog"]')
    .count()
    .catch(() => 0);
  if (!opened) {
    out.push({
      id: 'composer',
      ok: false,
      detail: 'composer dialog did not open',
      breaks: 'all write tools',
    });
    return;
  }
  for (const a of ANCHORS.filter((x) => x.surface === 'composer')) {
    const ok = await anchorPresent(page, a);
    out.push({ id: a.id, ok, detail: ok ? 'present' : 'NOT FOUND', breaks: a.breaks });
  }
  // Close cleanly.
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(800);
  for (const name of [/don't save/i, /^discard$/i]) {
    const b = page.getByRole('button', { name }).first();
    if (await b.count().catch(() => 0)) {
      await b.click({ timeout: 4000 }).catch(() => {});
      break;
    }
  }
  await page.waitForTimeout(600);
}

export function registerDoctorTool(server: McpServer): void {
  server.registerTool(
    'doctor',
    {
      title: 'Health check',
      description:
        'Check that this server can still drive Threads: session validity, and whether each DOM ' +
        'anchor the write tools depend on is still present. Run it when tools start failing oddly — ' +
        'Meta ships UI changes without notice, and a moved anchor otherwise shows up as a vague ' +
        '"could not confirm" from whichever tool happened to use it. Read-only: it opens the ' +
        'composer to inspect it but never posts, and discards any draft it would create.',
      inputSchema: {
        deep: z
          .boolean()
          .default(false)
          .describe(
            'Also load a real post page and the activity feed to check those anchors. Slower ' +
              '(several page loads); needs a post to exist on your timeline.',
          ),
      },
      outputSchema: {
        healthy: z.boolean(),
        checks: z.array(CheckSchema),
      },
      annotations: READ,
    },
    async ({ deep }) => {
      return withErrorHandling(async () => {
        const checks: Check[] = [];

        const signedIn = await isLoggedIn();
        checks.push({
          id: 'session',
          ok: signedIn,
          detail: signedIn ? 'session cookie present' : 'not signed in — run `npm run login`',
          breaks: 'everything',
        });

        if (signedIn) {
          const handle = await resolveOwnHandle();
          checks.push({
            id: 'own-handle',
            ok: Boolean(handle),
            detail: handle ? `@${handle}` : 'could not resolve from the nav',
            breaks: 'whoami, get_profile without an explicit handle',
          });

          await onPage(async (page) => {
            await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded', timeout: 45000 });
            await page.waitForTimeout(3000);
            for (const a of ANCHORS.filter((x) => x.surface === 'home')) {
              const ok = await anchorPresent(page, a);
              checks.push({ id: a.id, ok, detail: ok ? 'present' : 'NOT FOUND', breaks: a.breaks });
            }
            await checkComposer(page, checks);
          });

          // Extraction is checked separately from the DOM: the read path uses
          // GraphQL/embedded JSON, so it can break while every anchor is fine.
          const feed = await threadsCapture(`${BASE_URL}/`, 'FeedDirect', {
            dwellMs: 4000,
            enough: (b) => extractPosts(b).length >= 1,
          }).catch(() => [] as unknown[]);
          const posts = extractPosts(feed);
          checks.push({
            id: 'timeline-extraction',
            ok: posts.length > 0,
            detail: posts.length
              ? `${posts.length} post(s) parsed`
              : 'no posts parsed from the feed',
            breaks: 'get_timeline, and probably every other post read',
          });

          if (handle) {
            await onPage(async (page) => {
              await page.goto(profileUrl(handle), {
                waitUntil: 'domcontentloaded',
                timeout: 45000,
              });
              await page.waitForTimeout(3000);
              for (const a of ANCHORS.filter((x) => x.surface === 'profile')) {
                const ok = await anchorPresent(page, a);
                checks.push({
                  id: a.id,
                  ok,
                  detail: ok ? 'present' : 'NOT FOUND',
                  breaks: a.breaks,
                });
              }
            });
          }

          if (deep) {
            const activity = await threadsCapture(threadsUrl('/activity'), 'ActivityFeed', {
              dwellMs: 4000,
              enough: (b) => extractActivity(b).length >= 1,
            }).catch(() => [] as unknown[]);
            const stories = extractActivity(activity);
            checks.push({
              id: 'activity-extraction',
              ok: stories.length > 0,
              detail: stories.length ? `${stories.length} entr(ies) parsed` : 'no activity parsed',
              breaks: 'get_notifications',
            });

            const first = posts.find((p) => p.code && p.user?.username);
            if (first) {
              await onPage(async (page) => {
                await page.goto(`${BASE_URL}/@${first.user!.username}/post/${first.code}`, {
                  waitUntil: 'domcontentloaded',
                  timeout: 45000,
                });
                await page.waitForTimeout(3000);
                for (const a of ANCHORS.filter((x) => x.surface === 'post')) {
                  const ok = await anchorPresent(page, a);
                  checks.push({
                    id: a.id,
                    ok,
                    detail: ok ? 'present' : 'NOT FOUND',
                    breaks: a.breaks,
                  });
                }
              });
            } else {
              checks.push({
                id: 'post-anchors',
                ok: true,
                detail: 'skipped — no post available on the timeline to inspect',
              });
            }
          }
        }

        const failed = checks.filter((c) => !c.ok);
        const healthy = failed.length === 0;
        const lines = [
          healthy
            ? '✅ **Healthy** — session valid and every checked anchor is present.'
            : `⚠️ **${failed.length} check(s) failing** — Meta may have changed the UI.`,
          '',
          ...checks.map((c) => `${c.ok ? '✅' : '❌'} \`${c.id}\` — ${c.detail}`),
        ];
        if (!healthy) {
          lines.push(
            '',
            '**Impact:**',
            ...failed.map((c) => `- \`${c.id}\` → ${c.breaks ?? 'unknown'}`),
            '',
            '_Anchors are declared in `src/browser/selectors.ts`; update the ones that moved._',
          );
        }
        if (!deep) lines.push('', '_Run with `deep: true` to also check post and activity pages._');

        return {
          content: [{ type: 'text' as const, text: lines.join('\n') }],
          structuredContent: { healthy, checks },
        };
      });
    },
  );
}
