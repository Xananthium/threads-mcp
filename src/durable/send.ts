/** Crash-aware, single-account send records for text posts and replies. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import type { ThreadsPost } from '../api/types.js';

export type SendAction = 'post' | 'reply';
export type SendState = 'prepared' | 'attempted' | 'published';
export interface SendReceipt {
  id: string;
  permalink: string;
}
export interface SendRecord {
  version: 1;
  key: string;
  account: string;
  action: SendAction;
  text: string;
  target?: string;
  payloadHash: string;
  state: SendState;
  createdAt: string;
  attemptedAt?: string;
  receipt?: SendReceipt;
}

const ROOT = process.env.THREADS_SEND_DIR || path.join(os.homedir(), '.threads-mcp', 'sends');
const KEY = /^[A-Za-z0-9._:-]{1,128}$/;
const TARGET = /^https:\/\/www\.threads\.com\/@[A-Za-z0-9._]+\/post\/[A-Za-z0-9_-]+\/?$/;

function digest(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function dir(): string {
  fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 });
  fs.chmodSync(ROOT, 0o700);
  return ROOT;
}

function file(key: string): string {
  if (!KEY.test(key)) throw new Error('idempotencyKey must be 1–128 letters, numbers, . _ : or -');
  return path.join(dir(), `${digest(key)}.json`);
}

function payloadHash(account: string, action: SendAction, text: string, target?: string): string {
  return digest(JSON.stringify([account.toLowerCase(), action, text, target ?? null]));
}

function writeAtomic(destination: string, record: SendRecord): void {
  const temp = `${destination}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  const fd = fs.openSync(temp, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(record));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temp, destination);
  const directory = fs.openSync(path.dirname(destination), 'r');
  try {
    fs.fsyncSync(directory);
  } finally {
    fs.closeSync(directory);
  }
}

export function getSend(key: string): SendRecord | undefined {
  try {
    const saved = JSON.parse(fs.readFileSync(file(key), 'utf8')) as SendRecord;
    if (
      saved.version !== 1 ||
      saved.key !== key ||
      !/^[A-Za-z0-9._]{1,30}$/.test(saved.account) ||
      !['prepared', 'attempted', 'published'].includes(saved.state)
    ) {
      throw new Error('send record is invalid');
    }
    return saved;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export function prepareSend(
  key: string,
  account: string,
  action: SendAction,
  text: string,
  target?: string,
): SendRecord {
  if (!text.trim() || text.length > 500) throw new Error('text must contain 1–500 characters');
  if (!/^[A-Za-z0-9._]{1,30}$/.test(account)) throw new Error('account handle is invalid');
  if (action === 'reply' && (!target || !TARGET.test(target)))
    throw new Error('reply needs a full Threads post URL');
  const destination = file(key);
  const hash = payloadHash(account, action, text, target);
  const record: SendRecord = {
    version: 1,
    key,
    account,
    action,
    text,
    target,
    payloadHash: hash,
    state: 'prepared',
    createdAt: new Date().toISOString(),
  };
  try {
    const fd = fs.openSync(destination, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(record));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    const directory = fs.openSync(path.dirname(destination), 'r');
    try {
      fs.fsyncSync(directory);
    } finally {
      fs.closeSync(directory);
    }
    return record;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const saved = getSend(key)!;
    if (saved.payloadHash !== hash)
      throw new Error('idempotencyKey already belongs to different content', { cause: error });
    return saved;
  }
}

/** One process owns a key at a time; a dead owner's lock can be recovered. */
export async function withSendLock<T>(key: string, action: () => Promise<T>): Promise<T> {
  const lockPath = `${file(key)}.lock`;
  let fd: number;
  try {
    fd = fs.openSync(lockPath, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    let stale = false;
    try {
      const owner = Number(fs.readFileSync(lockPath, 'utf8'));
      if (Number.isInteger(owner) && owner > 0) {
        try {
          process.kill(owner, 0);
        } catch (e) {
          stale = (e as NodeJS.ErrnoException).code === 'ESRCH';
        }
      }
    } catch {
      /* another process may still be writing its owner */
    }
    if (!stale)
      throw new Error('send is already in progress; inspect its record and retry later', {
        cause: error,
      });
    fs.unlinkSync(lockPath);
    fd = fs.openSync(lockPath, 'wx', 0o600);
  }
  try {
    fs.writeFileSync(fd, String(process.pid));
    fs.fsyncSync(fd);
    return await action();
  } finally {
    fs.closeSync(fd);
    fs.rmSync(lockPath, { force: true });
  }
}

export function markAttempted(record: SendRecord): SendRecord {
  const current = getSend(record.key);
  if (!current || current.payloadHash !== record.payloadHash || current.state !== 'prepared') {
    throw new Error('send is not prepared');
  }
  const updated: SendRecord = {
    ...current,
    state: 'attempted',
    attemptedAt: new Date().toISOString(),
  };
  writeAtomic(file(record.key), updated);
  return updated;
}

export function markPublished(record: SendRecord, receipt: SendReceipt): SendRecord {
  const current = getSend(record.key);
  if (!current || current.payloadHash !== record.payloadHash || current.state !== 'attempted') {
    throw new Error('send has no attempt to reconcile');
  }
  const updated: SendRecord = { ...current, state: 'published', receipt };
  writeAtomic(file(record.key), updated);
  return updated;
}

export function receiptFromPosts(
  posts: ThreadsPost[],
  record: SendRecord,
  ownHandle: string,
): SendReceipt | undefined {
  const earliest = record.attemptedAt ? Date.parse(record.attemptedAt) / 1000 - 30 : Infinity;
  const targetAuthor = record.target?.match(/\/@([A-Za-z0-9._]+)\/post\//)?.[1]?.toLowerCase();
  if (record.action === 'reply') {
    const parent = posts.find((p) =>
      Boolean(
        p.user?.username &&
        p.user.username.toLowerCase() === targetAuthor &&
        `https://www.threads.com/@${p.user.username}/post/${p.code}` === record.target,
      ),
    );
    if (!parent) return undefined;
  }
  const found = posts.filter((p) => {
    const id = String(p.pk || p.id || '');
    if (
      !/^\d+$/.test(id) ||
      !p.code ||
      p.user?.username?.toLowerCase() !== ownHandle.toLowerCase() ||
      p.caption?.text?.trimEnd() !== record.text.trimEnd() ||
      typeof p.taken_at !== 'number' ||
      p.taken_at < earliest
    )
      return false;
    const info = p.text_post_app_info;
    return record.action === 'reply'
      ? info?.is_reply === true && info.reply_to_author?.username?.toLowerCase() === targetAuthor
      : info?.is_reply !== true;
  });
  if (found.length !== 1) return undefined;
  const post = found[0];
  return {
    id: String(post.pk || post.id),
    permalink: `https://www.threads.com/@${ownHandle}/post/${post.code}`,
  };
}
