import { afterEach, describe, expect, test } from 'bun:test';

import { DatagramError } from '../src/packages/application/errors';
import { bundledChannelTypes } from '../src/packages/domain/channel-types';
import { createRuntime, type DatagramRuntime } from '../src/packages/runtime';

const openRuntimes: DatagramRuntime[] = [];

async function runtime() {
  const value = await createRuntime({ databasePath: ':memory:' });
  openRuntimes.push(value);
  return value;
}

async function createPerson(value: DatagramRuntime, displayName: string) {
  const receipt = await value.app.executeAction(
    value.owner.id,
    'cli',
    'service.person.create',
    { displayName },
  );
  return receipt.subject!.id;
}

async function createChannel(value: DatagramRuntime, typeId: string) {
  if (typeId === 'chart') {
    const source = await value.app.executeAction(value.owner.id, 'cli', 'channel.create', {
      title: 'chart source',
      typeId: 'table',
    });
    const prepared = await value.app.prepareQuery(
      value.owner.id,
      'agent',
      'table.records.list',
      { channelId: source.subject!.id },
      'chart.aggregate',
    );
    const aggregated = await value.app.composeResultHandle(value.owner.id, {
      handleId: prepared.id,
      inputPurpose: 'chart.aggregate',
      outputPurpose: 'chart.create',
      transform: {
        aggregations: [{ as: 'count', operator: 'count' }],
        kind: 'aggregate',
      },
    });
    const receipt = await value.app.executeAction(value.owner.id, 'cli', 'chart.create', {
      handleId: aggregated.id,
      presentation: { series: ['count'], type: 'bar' },
      title: 'chart discussion',
    });
    return receipt.subject!.id;
  }
  const receipt = await value.app.executeAction(
    value.owner.id,
    'cli',
    'channel.create',
    { title: `${typeId} discussion`, typeId },
  );
  return receipt.subject!.id;
}

async function expectDenied(action: Promise<unknown>) {
  try {
    await action;
    throw new Error('Expected permission denial');
  } catch (error) {
    expect(error).toBeInstanceOf(DatagramError);
    expect((error as DatagramError).code).toBe('permission.denied');
  }
}

afterEach(async () => {
  await Promise.all(openRuntimes.splice(0).map((value) => value.close()));
});

describe('universal Discussion lifecycle', () => {
  test('bundles Discussion actions into every Channel Type and accepts Contributor posts', async () => {
    const value = await runtime();
    const contributorId = await createPerson(value, 'Contributor');

    for (const type of bundledChannelTypes) {
      expect(type.actions).toEqual(
        expect.arrayContaining([
          'discussion.message.post',
          'discussion.message.edit',
          'discussion.message.tombstone',
          'discussion.message.restore',
        ]),
      );
      const channelId = await createChannel(value, type.id);
      await value.app.executeAction(value.owner.id, 'cli', 'channel.member.grant', {
        channelId,
        personId: contributorId,
        role: 'contributor',
      });
      const receipt = await value.app.executeAction(
        contributorId,
        'mcp',
        'discussion.message.post',
        { channelId, text: `${type.id} message` },
      );
      expect((await value.store.getMessage(receipt.subject!.id))?.channelId).toBe(channelId);
    }
  });

  test('keeps replies flat, preserves stable Record references and revisions, and hides tombstones', async () => {
    const value = await runtime();
    const channelId = await createChannel(value, 'table');
    const contributorId = await createPerson(value, 'Contributor');
    const otherContributorId = await createPerson(value, 'Other Contributor');
    const viewerId = await createPerson(value, 'Viewer');
    const adminId = await createPerson(value, 'Admin');
    for (const [personId, role] of [
      [contributorId, 'contributor'],
      [otherContributorId, 'contributor'],
      [viewerId, 'viewer'],
      [adminId, 'admin'],
    ] as const) {
      await value.app.executeAction(value.owner.id, 'cli', 'channel.member.grant', {
        channelId,
        personId,
        role,
      });
    }

    const beforeOperations = await value.store.listOperations(channelId);
    const beforeActivities = await value.store.listActivities(channelId);
    const parent = await value.app.executeAction(
      contributorId,
      'cli',
      'discussion.message.post',
      {
        channelId,
        recordReferences: ['record-stable', 'record-unresolved'],
        text: 'Parent',
      },
    );
    const reply = await value.app.executeAction(
      contributorId,
      'http',
      'discussion.message.post',
      {
        channelId,
        replyToMessageId: parent.subject!.id,
        text: 'Reply',
      },
    );
    const nestedReply = await value.app.executeAction(
      contributorId,
      'mcp',
      'discussion.message.post',
      {
        channelId,
        replyToMessageId: reply.subject!.id,
        text: 'Still flat',
      },
    );
    await value.app.executeAction(
      contributorId,
      'agent',
      'discussion.message.edit',
      { channelId, messageId: reply.subject!.id, text: 'Edited reply' },
    );

    const listed = await value.app.executeQuery(
      contributorId,
      'cli',
      'discussion.messages.list',
      { channelId },
    );
    expect(listed.data).toHaveLength(3);
    expect(listed.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: parent.subject!.id,
          recordReferences: [
            { recordId: 'record-stable', status: 'unresolved' },
            { recordId: 'record-unresolved', status: 'unresolved' },
          ],
        }),
        expect.objectContaining({
          id: reply.subject!.id,
          replyToMessageId: parent.subject!.id,
          text: 'Edited reply',
        }),
        expect.objectContaining({
          id: nestedReply.subject!.id,
          replyToMessageId: reply.subject!.id,
        }),
      ]),
    );

    const revisions = await value.app.executeQuery(
      contributorId,
      'cli',
      'discussion.message.revisions',
      { channelId, messageId: reply.subject!.id },
    );
    expect(revisions.data).toEqual([
      expect.objectContaining({ text: 'Reply' }),
      expect.objectContaining({ text: 'Edited reply' }),
    ]);
    await expectDenied(
      value.app.executeQuery(
        otherContributorId,
        'cli',
        'discussion.message.revisions',
        { channelId, messageId: reply.subject!.id },
      ),
    );
    await value.app.executeQuery(adminId, 'cli', 'discussion.message.revisions', {
      channelId,
      messageId: reply.subject!.id,
    });

    await value.app.executeAction(
      contributorId,
      'workflow',
      'discussion.message.tombstone',
      { channelId, messageId: reply.subject!.id },
    );
    let tombstone = (
      await value.app.executeQuery(viewerId, 'http', 'discussion.messages.list', { channelId })
    ).data as Array<Record<string, unknown>>;
    expect(tombstone.find((message) => message.id === reply.subject!.id)).toMatchObject({
      recordReferences: [],
      text: null,
      tombstonedAt: expect.any(String),
    });
    await value.app.executeAction(
      contributorId,
      'cli',
      'discussion.message.restore',
      { channelId, messageId: reply.subject!.id },
    );
    await value.app.executeAction(adminId, 'cli', 'discussion.message.tombstone', {
      channelId,
      messageId: parent.subject!.id,
    });
    await value.app.executeAction(value.owner.id, 'cli', 'discussion.message.restore', {
      channelId,
      messageId: parent.subject!.id,
    });
    tombstone = (
      await value.app.executeQuery(viewerId, 'http', 'discussion.messages.list', { channelId })
    ).data as Array<Record<string, unknown>>;
    expect(tombstone.find((message) => message.id === parent.subject!.id)).toMatchObject({
      recordReferences: [
        { recordId: 'record-stable', status: 'unresolved' },
        { recordId: 'record-unresolved', status: 'unresolved' },
      ],
      text: 'Parent',
    });

    const acceptedMutationCount = 8;
    const operations = await value.store.listOperations(channelId);
    expect(operations).toHaveLength(beforeOperations.length + acceptedMutationCount);
    expect(await value.store.listActivities(channelId)).toHaveLength(
      beforeActivities.length + acceptedMutationCount,
    );
    const previousOperationIds = new Set(beforeOperations.map((operation) => operation.id));
    const discussionOperations = operations.filter(
      (operation) => !previousOperationIds.has(operation.id),
    );
    expect(discussionOperations).toHaveLength(acceptedMutationCount);
    for (const operation of discussionOperations) {
      expect(
        operation.changes.filter((change) => change.kind === 'activity.appended'),
      ).toHaveLength(1);
    }
  });

  test('denies Viewer mutations and non-author edits without partial Operations or Activity', async () => {
    const value = await runtime();
    const channelId = await createChannel(value, 'dictionary');
    const authorId = await createPerson(value, 'Author');
    const otherId = await createPerson(value, 'Other');
    const viewerId = await createPerson(value, 'Viewer');
    for (const [personId, role] of [
      [authorId, 'contributor'],
      [otherId, 'contributor'],
      [viewerId, 'viewer'],
    ] as const) {
      await value.app.executeAction(value.owner.id, 'cli', 'channel.member.grant', {
        channelId,
        personId,
        role,
      });
    }
    const posted = await value.app.executeAction(
      authorId,
      'cli',
      'discussion.message.post',
      { channelId, text: 'Protected' },
    );
    const operationCount = (await value.store.listOperations(channelId)).length;
    const activityCount = (await value.store.listActivities(channelId)).length;

    await expectDenied(
      value.app.executeAction(viewerId, 'cli', 'discussion.message.post', {
        channelId,
        text: 'Denied',
      }),
    );
    await expectDenied(
      value.app.executeAction(viewerId, 'cli', 'discussion.message.tombstone', {
        channelId,
        messageId: posted.subject!.id,
      }),
    );
    await expectDenied(
      value.app.executeAction(otherId, 'cli', 'discussion.message.edit', {
        channelId,
        messageId: posted.subject!.id,
        text: 'Denied',
      }),
    );
    expect(await value.store.listOperations(channelId)).toHaveLength(operationCount);
    expect(await value.store.listActivities(channelId)).toHaveLength(activityCount);
  });
});
