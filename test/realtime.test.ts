import { afterEach, describe, expect, test } from 'bun:test';

import { createDevelopmentHttpHandler } from '../src/packages/http';
import { createRuntime, type DatagramRuntime } from '../src/packages/runtime';
import type { SubscriptionEvent } from '../src/packages/domain/model';

const openRuntimes: DatagramRuntime[] = [];

async function runtime() {
  const value = await createRuntime({ databasePath: ':memory:' });
  openRuntimes.push(value);
  return value;
}

async function take(
  events: AsyncIterable<SubscriptionEvent>,
  count: number,
): Promise<SubscriptionEvent[]> {
  const iterator = events[Symbol.asyncIterator]();
  const values: SubscriptionEvent[] = [];
  try {
    while (values.length < count) {
      const next = await iterator.next();
      if (next.done) break;
      values.push(next.value);
    }
  } finally {
    await iterator.return?.();
  }
  return values;
}

afterEach(async () => {
  await Promise.all(openRuntimes.splice(0).map((value) => value.close()));
});

describe('authorized realtime Activity', () => {
  test('orders Activity, correlates Action results, resumes, and keeps mute separate from unread', async () => {
    const value = await runtime();
    const channel = await value.app.executeAction(value.owner.id, 'cli', 'channel.create', {
      title: 'Shared',
      typeId: 'table',
    });
    const channelId = channel.subject!.id;
    const person = await value.app.executeAction(value.owner.id, 'cli', 'service.person.create', {
      displayName: 'Other',
    });
    const personId = person.subject!.id;
    await value.app.executeAction(value.owner.id, 'cli', 'channel.member.grant', {
      channelId,
      personId,
      role: 'contributor',
    });
    await value.app.executeAction(personId, 'cli', 'channel.activity.mark-read', { channelId });
    const before = await value.store.listSubscriptionEvents(0, 100);
    const after = before.at(-1)!.position;

    const record = await value.app.executeAction(value.owner.id, 'cli', 'table.record.create', {
      channelId,
      values: {},
    });
    const mute = await value.app.executeAction(personId, 'cli', 'channel.navigation.mute', {
      channelId,
      muted: true,
    });

    const delivered = await take(value.app.subscribe(personId, { after }), 2);
    expect(delivered.map((event) => event.type)).toEqual(['activity', 'operation-result']);
    expect(delivered[0]!.position).toBeLessThan(delivered[1]!.position);
    expect(delivered[0]).toMatchObject({
      activity: { operationId: record.operationId },
      id: expect.stringMatching(/^activity_/),
      type: 'activity',
    });
    expect(delivered[1]).toMatchObject({
      action: 'channel.navigation.mute',
      operationId: mute.operationId,
      status: 'succeeded',
      type: 'operation-result',
    });

    const first = delivered[0]!;
    const resumed = await take(value.app.subscribe(personId, { after: first.position }), 1);
    expect(resumed).toEqual([delivered[1]!]);

    const list = await value.app.executeQuery(personId, 'cli', 'channel.list', {});
    expect(list.data).toEqual([
      expect.objectContaining({ id: channelId, muted: true, unreadCount: 1 }),
    ]);
    const activity = first.type === 'activity' ? first.activity : undefined;
    await value.app.executeAction(personId, 'cli', 'channel.activity.mark-read', {
      activityId: activity!.id,
      channelId,
    });
    const readList = await value.app.executeQuery(personId, 'cli', 'channel.list', {});
    expect(readList.data).toEqual([
      expect.objectContaining({
        id: channelId,
        lastReadActivityId: activity!.id,
        muted: true,
        unreadCount: 0,
      }),
    ]);

    const firstActivityList = await value.app.executeQuery(
      personId,
      'cli',
      'channel.activity.list',
      { channelId },
    );
    const secondActivityList = await value.app.executeQuery(
      personId,
      'cli',
      'channel.activity.list',
      { channelId },
    );
    expect(secondActivityList.data).toEqual(firstActivityList.data);
    const positions = (firstActivityList.data as Array<{ position: number }>).map(
      (item) => item.position,
    );
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
  });

  test('cuts delivery off when Channel permission is revoked', async () => {
    const value = await runtime();
    const channel = await value.app.executeAction(value.owner.id, 'cli', 'channel.create', {
      title: 'Revoked',
      typeId: 'table',
    });
    const channelId = channel.subject!.id;
    const person = await value.app.executeAction(value.owner.id, 'cli', 'service.person.create', {
      displayName: 'Other',
    });
    const personId = person.subject!.id;
    const grant = await value.app.executeAction(value.owner.id, 'cli', 'channel.member.grant', {
      channelId,
      personId,
      role: 'viewer',
    });
    const before = await value.store.listSubscriptionEvents(0, 100);
    const after = before.at(-1)!.position;

    await value.app.executeAction(value.owner.id, 'cli', 'operation.undo', {
      channelId,
      operationId: grant.operationId,
    });
    await value.app.executeAction(value.owner.id, 'cli', 'discussion.message.post', {
      channelId,
      text: 'Not delivered',
    });

    const abort = new AbortController();
    setTimeout(() => abort.abort(), 75);
    const iterator = value.app
      .subscribe(personId, { after, signal: abort.signal })
      [Symbol.asyncIterator]();
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
  });

  test('SSE transport uses event positions for gap-free resume', async () => {
    const value = await runtime();
    const channel = await value.app.executeAction(value.owner.id, 'cli', 'channel.create', {
      title: 'Streamed',
      typeId: 'table',
    });
    const before = await value.store.listSubscriptionEvents(0, 100);
    const after = before.at(-1)!.position;
    const receipt = await value.app.executeAction(
      value.owner.id,
      'cli',
      'channel.navigation.mute',
      { channelId: channel.subject!.id, muted: true },
    );
    const fetch = createDevelopmentHttpHandler({
      app: value.app,
      defaultActorId: value.owner.id,
    });
    const response = await fetch(
      new Request('http://datagram.test/v1/events', {
        headers: { 'last-event-id': String(after) },
      }),
    );
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const reader = response.body!.getReader();
    const chunk = await reader.read();
    await reader.cancel();
    const text = new TextDecoder().decode(chunk.value);
    expect(text).toContain('event: operation-result');
    expect(text).toContain(`"operationId":"${receipt.operationId}"`);
    expect(text).not.toContain('Streamed');
  });
});
