import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'threads-durable-test-'));
process.env.THREADS_SEND_DIR = root;
const { getSend, prepareSend, markAttempted, markPublished, receiptFromPosts, withSendLock } =
  await import('../../src/durable/send.js');

test('one key keeps one frozen payload and a durable provider receipt', () => {
  const prepared = prepareSend('post-1', 'mine', 'post', 'One complete thought.');
  assert.equal(prepared.state, 'prepared');
  assert.equal(prepareSend('post-1', 'mine', 'post', 'One complete thought.').state, 'prepared');
  assert.throws(
    () => prepareSend('post-1', 'mine', 'post', 'Different text.'),
    /different content/,
  );
  assert.throws(
    () => prepareSend('post-1', 'another', 'post', 'One complete thought.'),
    /different content/,
  );
  const attempted = markAttempted(prepared);
  assert.equal(getSend('post-1')?.state, 'attempted');
  assert.throws(() => markAttempted(prepared), /not prepared/);
  const published = markPublished(attempted, {
    id: '123',
    permalink: 'https://www.threads.com/@mine/post/ABC',
  });
  assert.equal(published.state, 'published');
  assert.equal(getSend('post-1')?.receipt?.id, '123');
  assert.equal(
    fs.statSync(
      path.join(
        root,
        fs.readdirSync(root).find((x) => x.endsWith('.json'))!,
      ),
    ).mode & 0o077,
    0,
  );
});

test('a reply receipt requires the exact thread, body, account and parent author', () => {
  const target = 'https://www.threads.com/@other/post/TARGET';
  const record = markAttempted(prepareSend('reply-1', 'mine', 'reply', 'A reply.', target));
  const now = Math.floor(Date.now() / 1000);
  const parent = {
    pk: '90',
    code: 'TARGET',
    user: { username: 'other' },
    caption: { text: 'Question' },
  };
  const reply = {
    pk: '123',
    code: 'REPLY',
    taken_at: now,
    user: { username: 'mine' },
    caption: { text: 'A reply.' },
    text_post_app_info: { is_reply: true, reply_to_author: { username: 'other' } },
  };
  assert.deepEqual(receiptFromPosts([parent, reply], record, 'mine'), {
    id: '123',
    permalink: 'https://www.threads.com/@mine/post/REPLY',
  });
  assert.equal(receiptFromPosts([reply], record, 'mine'), undefined);
  assert.equal(
    receiptFromPosts(
      [
        parent,
        {
          ...reply,
          text_post_app_info: {
            is_reply: true,
            reply_to_author: { username: 'someone_else' },
          },
        },
      ],
      record,
      'mine',
    ),
    undefined,
  );
  assert.equal(
    receiptFromPosts([parent, reply, { ...reply, pk: '124', code: 'REPLY2' }], record, 'mine'),
    undefined,
  );
});

test('a simultaneous call with the same key cannot make a second attempt', async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = withSendLock('locked', async () => {
    await pending;
    return 1;
  });
  await assert.rejects(
    withSendLock('locked', async () => 2),
    /already in progress/,
  );
  release();
  assert.equal(await first, 1);
  assert.equal(await withSendLock('locked', async () => 3), 3);
});
