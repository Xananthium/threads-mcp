/** MCP tools that add crash-aware text sends to the existing browser client. */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { threadsCapture, profileUrl } from '../api/client.js';
import { extractPosts } from '../api/extract.js';
import { resolveOwnHandle } from '../browser/session.js';
import { publishThread, publishTextReply } from '../tools/write.js';
import { WRITE_CREATES } from '../utils/annotations.js';
import {
  getSend,
  markAttempted,
  markPublished,
  prepareSend,
  receiptFromPosts,
  withSendLock,
  type SendAction,
  type SendRecord,
} from './send.js';

type SendResult = {
  status: string;
  key: string;
  provider_id?: string;
  permalink?: string;
  reason?: string;
  next_step?: string;
};

function result(value: SendResult) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
    structuredContent: value,
    isError: [
      'failed_before_send',
      'key_conflict',
      'send_in_progress',
      'invalid_target',
      'local_state_unavailable',
    ].includes(value.status),
  };
}

function localError(key: string, error: unknown): SendResult {
  const message = error instanceof Error ? error.message : '';
  const status = message.includes('different content')
    ? 'key_conflict'
    : message.includes('already in progress')
      ? 'send_in_progress'
      : message.includes('reply needs a full')
        ? 'invalid_target'
        : 'local_state_unavailable';
  return { status, key };
}

function view(record: SendRecord): SendResult {
  return record.state === 'published'
    ? {
        status: 'published',
        key: record.key,
        provider_id: record.receipt!.id,
        permalink: record.receipt!.permalink,
      }
    : {
        status: record.state,
        key: record.key,
        next_step: record.state === 'attempted' ? 'reconcile_durable_send' : 'retry_same_key',
      };
}

async function reconcile(record: SendRecord): Promise<SendResult> {
  if (record.state !== 'attempted') return view(record);
  let ownHandle: string | undefined;
  try {
    ownHandle = await resolveOwnHandle();
  } catch {
    /* account browser is unavailable; the send record stays attempted */
  }
  if (!ownHandle)
    return {
      status: 'unconfirmed',
      key: record.key,
      reason: 'account_identity_unavailable',
      next_step: 'reconcile_durable_send',
    };
  if (ownHandle.toLowerCase() !== record.account.toLowerCase())
    return {
      status: 'unconfirmed',
      key: record.key,
      reason: 'account_mismatch',
      next_step: 'reconcile_durable_send',
    };
  const target = record.action === 'reply' ? record.target! : profileUrl(ownHandle);
  try {
    const posts = extractPosts(
      await threadsCapture(target, record.action === 'reply' ? 'PostPage' : 'ProfileThreadsTab', {
        dwellMs: 5000,
      }),
    );
    const receipt = receiptFromPosts(posts, record, ownHandle);
    if (receipt) return view(markPublished(record, receipt));
  } catch {
    /* leave the attempted record intact for another read */
  }
  return {
    status: 'unconfirmed',
    key: record.key,
    reason: 'receipt_not_found',
    next_step: 'reconcile_durable_send',
  };
}

async function send(
  key: string,
  action: SendAction,
  text: string,
  target?: string,
): Promise<SendResult> {
  return withSendLock(key, async () => {
    const account = await resolveOwnHandle();
    if (!account)
      return {
        status: 'failed_before_send',
        key,
        reason: 'account_identity_unavailable',
        next_step: 'retry_same_key',
      };
    let record = prepareSend(key, account, action, text, target);
    if (record.state === 'published') return view(record);
    if (record.state === 'attempted') return reconcile(record);
    try {
      const beforeSubmit = () => {
        record = markAttempted(record);
      };
      if (action === 'post') await publishThread({ text, beforeSubmit });
      else await publishTextReply({ text, target: target!, beforeSubmit });
    } catch {
      if (record.state === 'prepared')
        return {
          status: 'failed_before_send',
          key,
          reason: 'composer_or_session_unavailable',
          next_step: 'retry_same_key',
        };
    }
    // The browser can close before the provider receipt appears. Read a few
    // times, then leave the send uncertain; the same key never submits twice.
    for (let attempt = 0; attempt < 4; attempt++) {
      const confirmed = await reconcile(record);
      if (confirmed.status === 'published') return confirmed;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    return {
      status: 'uncertain',
      key,
      reason: 'receipt_not_yet_visible',
      next_step: 'reconcile_durable_send',
    };
  });
}

export function registerDurableTools(server: McpServer): void {
  server.registerTool(
    'durable_create_thread',
    {
      title: 'Post a text thread with a durable receipt',
      description:
        'Send one exact text post. Reuse its idempotencyKey to get the same receipt; a crash or uncertain result is reconciled without another submit.',
      inputSchema: {
        text: z.string().min(1).max(500),
        idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
      },
      annotations: { ...WRITE_CREATES, idempotentHint: true },
    },
    async ({ text, idempotencyKey }) => {
      try {
        return result(await send(idempotencyKey, 'post', text));
      } catch (error) {
        return result(localError(idempotencyKey, error));
      }
    },
  );

  server.registerTool(
    'durable_reply_to_thread',
    {
      title: 'Reply with a durable receipt',
      description:
        'Reply once to an exact Threads post URL. Reuse the same idempotencyKey for the same text and target; uncertain sends are reconciled without resending.',
      inputSchema: {
        text: z.string().min(1).max(500),
        targetUrl: z.string().url(),
        idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
      },
      annotations: { ...WRITE_CREATES, idempotentHint: true },
    },
    async ({ text, targetUrl, idempotencyKey }) => {
      try {
        return result(await send(idempotencyKey, 'reply', text, targetUrl));
      } catch (error) {
        return result(localError(idempotencyKey, error));
      }
    },
  );

  server.registerTool(
    'get_durable_send',
    {
      title: 'Inspect one durable send',
      description: 'Read the local state and provider receipt for an idempotencyKey.',
      inputSchema: { idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/) },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ idempotencyKey }) => {
      try {
        const record = getSend(idempotencyKey);
        return result(record ? view(record) : { status: 'not_found', key: idempotencyKey });
      } catch {
        return result({ status: 'local_state_unavailable', key: idempotencyKey });
      }
    },
  );

  server.registerTool(
    'reconcile_durable_send',
    {
      title: 'Confirm an existing Threads send',
      description:
        'Read Threads for one exact attempted send. Saves a unique provider receipt when found and never submits again.',
      inputSchema: { idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/) },
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ idempotencyKey }) => {
      try {
        return result(
          await withSendLock(idempotencyKey, async () => {
            const record = getSend(idempotencyKey);
            return record ? reconcile(record) : { status: 'not_found', key: idempotencyKey };
          }),
        );
      } catch {
        return result({ status: 'local_state_unavailable', key: idempotencyKey });
      }
    },
  );
}
