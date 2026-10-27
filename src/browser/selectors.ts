// ─── DOM anchors ──────────────────────────────────────────────────────────────
//
// Every write in this server drives Meta's real UI, so it depends on a handful
// of DOM anchors — an aria-label here, a button name there. Meta ships UI
// changes without notice, and when one of these moves the failure is quiet: a
// click lands on nothing, a tool reports "couldn't confirm", and the cause is
// several layers away from the symptom.
//
// Collecting them here does two things: it makes the surface auditable in one
// place, and it lets the `doctor` tool check each anchor against the live site
// so drift is a same-day signal instead of a user bug report.
//
// This is documentation of a dependency, not an abstraction over it — the tools
// still use Playwright locators directly, because a wrapper that hid which
// anchor failed would defeat the point.

/** What kind of page an anchor lives on, so `doctor` knows where to look. */
export type Surface = 'home' | 'composer' | 'profile' | 'post' | 'activity';

export interface Anchor {
  /** Stable id used in `doctor` output. */
  id: string;
  surface: Surface;
  /** What breaks if this anchor disappears. */
  breaks: string;
  /** A CSS selector, evaluated in the page. */
  css?: string;
  /** Exact-ish visible text to look for, when there is no stable selector. */
  text?: RegExp;
  /**
   * False when the anchor only exists in some states — a post you have already
   * liked shows "Unlike", not "Like" — so its absence is not itself a failure.
   */
  required: boolean;
}

export const ANCHORS: Anchor[] = [
  // ── home ────────────────────────────────────────────────────────────────
  {
    id: 'composer-opener',
    surface: 'home',
    breaks: 'create_thread cannot open the composer',
    text: /what['’]s new\?|start a thread|new thread/i,
    required: true,
  },
  {
    id: 'profile-nav-link',
    surface: 'home',
    breaks: 'whoami / get_profile cannot resolve your own handle',
    css: 'a[href^="/@"]',
    required: true,
  },

  // ── composer ────────────────────────────────────────────────────────────
  {
    id: 'composer-editor',
    surface: 'composer',
    breaks: 'no post can be typed',
    css: 'div[role="dialog"] [contenteditable="true"]',
    required: true,
  },
  {
    id: 'composer-post-button',
    surface: 'composer',
    breaks: 'nothing can be submitted',
    text: /^post$/i,
    required: true,
  },
  {
    id: 'composer-add-to-thread',
    surface: 'composer',
    breaks: 'create_thread `chain` posts would become separate threads',
    text: /^add to thread$/i,
    required: true,
  },
  {
    id: 'composer-attach-media',
    surface: 'composer',
    breaks: 'media cannot be attached to replies',
    // Uploads use the file input directly; the decorative icon label varies.
    css: 'input[type="file"], svg[aria-label="Attach media"]',
    required: true,
  },
  {
    id: 'composer-file-input',
    surface: 'composer',
    breaks: 'media upload has no input to feed',
    css: 'input[type="file"]',
    required: true,
  },

  // ── profile ─────────────────────────────────────────────────────────────
  {
    id: 'followers-trigger',
    surface: 'profile',
    breaks: 'get_followers / get_following cannot open the list',
    text: /followers/i,
    required: true,
  },

  // ── post page ───────────────────────────────────────────────────────────
  {
    id: 'post-column',
    surface: 'post',
    breaks: 'action clicks hit the nav instead of the post',
    css: '[aria-label="Column body"]',
    required: true,
  },
  {
    id: 'post-like',
    surface: 'post',
    breaks: 'like_thread / unlike_thread',
    // Absent when the post is already liked, which shows "Unlike" instead.
    css: 'svg[aria-label="Like"], svg[aria-label="Unlike"]',
    required: true,
  },
  {
    id: 'post-repost',
    surface: 'post',
    breaks: 'repost_thread / quote_thread / unrepost_thread',
    css: 'svg[aria-label="Repost"]',
    required: true,
  },
  {
    id: 'post-more-menu',
    surface: 'post',
    breaks: 'delete_thread cannot reach the Delete option',
    css: 'svg[aria-label="More"]',
    required: true,
  },

  // ── activity ────────────────────────────────────────────────────────────
  {
    id: 'activity-feed',
    surface: 'activity',
    breaks: 'get_notifications returns nothing',
    css: 'a[href*="/activity"]',
    required: true,
  },
];
