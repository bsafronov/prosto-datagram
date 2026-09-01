import { afterEach, describe, expect, test } from 'bun:test';

import { DatagramError } from '../src/packages/application/errors';
import { ResultHandleBroker } from '../src/packages/application/result-handles';
import type { DatagramRuntime } from '../src/packages/runtime';
import { createRuntime } from '../src/packages/runtime';

const openRuntimes: DatagramRuntime[] = [];

async function runtime() {
  const value = await createRuntime({ databasePath: ':memory:' });
  openRuntimes.push(value);
  return value;
}

async function table(value: DatagramRuntime) {
  const channel = await value.app.executeAction(value.owner.id, 'cli', 'channel.create', {
    title: 'Classified Revenue',
    typeId: 'table',
  });
  const channelId = channel.subject!.id;
  const category = await value.app.executeAction(value.owner.id, 'cli', 'table.field.add', {
    channelId,
    key: 'category',
    label: 'Secret Category',
    required: true,
    type: 'text',
    unique: false,
  });
  const amount = await value.app.executeAction(value.owner.id, 'cli', 'table.field.add', {
    channelId,
    key: 'amount',
    label: 'Secret Amount',
    required: true,
    type: 'number',
    unique: false,
  });
  for (const values of [
    { amount: 12, category: 'Hidden North' },
    { amount: 8, category: 'Hidden North' },
    { amount: 30, category: 'Hidden South' },
  ]) {
    await value.app.executeAction(value.owner.id, 'agent', 'table.record.create', {
      channelId,
      values,
    });
  }
  return { amountId: amount.subject!.id, categoryId: category.subject!.id, channelId };
}

afterEach(async () => {
  await Promise.all(openRuntimes.splice(0).map((value) => value.close()));
});

describe('Result Handles', () => {
  test('bind service, actor, purpose, expiry, and source authorization', async () => {
    const value = await runtime();
    const { channelId } = await table(value);
    const viewer = await value.app.executeAction(value.owner.id, 'cli', 'service.person.create', {
      displayName: 'Viewer',
    });
    await value.app.executeAction(value.owner.id, 'cli', 'channel.member.grant', {
      channelId,
      personId: viewer.subject!.id,
      role: 'viewer',
    });
    const handle = await value.app.prepareQuery(
      viewer.subject!.id,
      'agent',
      'table.records.list',
      { channelId },
      'chart.source',
    );

    await expect(
      value.app.handles.consume(
        'another-service',
        viewer.subject!.id,
        handle.id,
        'chart.source',
      ),
    ).rejects.toMatchObject({
      code: 'result-handle.service-mismatch',
    } satisfies Partial<DatagramError>);
    await expect(
      value.app.consumeResultHandle(value.owner.id, handle.id, 'chart.source'),
    ).rejects.toMatchObject({
      code: 'result-handle.actor-mismatch',
    } satisfies Partial<DatagramError>);
    await expect(
      value.app.consumeResultHandle(viewer.subject!.id, handle.id, 'another-purpose'),
    ).rejects.toMatchObject({
      code: 'result-handle.purpose-mismatch',
    } satisfies Partial<DatagramError>);

    await value.app.executeAction(viewer.subject!.id, 'cli', 'channel.member.leave', { channelId });
    await expect(
      value.app.consumeResultHandle(viewer.subject!.id, handle.id, 'chart.source'),
    ).rejects.toMatchObject({
      code: 'result-handle.source-unavailable',
      message: 'Result Handle source authorization is no longer valid',
    } satisfies Partial<DatagramError>);

    const ownerHandle = await value.app.prepareQuery(
      value.owner.id,
      'agent',
      'table.records.list',
      { channelId },
      'deleted.source',
    );
    await value.app.executeAction(value.owner.id, 'cli', 'channel.delete', { channelId });
    await expect(
      value.app.consumeResultHandle(value.owner.id, ownerHandle.id, 'deleted.source'),
    ).rejects.toMatchObject({
      code: 'result-handle.source-unavailable',
    } satisfies Partial<DatagramError>);

    let now = 1_000;
    const broker = new ResultHandleBroker({
      clock: () => now,
      serviceId: 'service-a',
      ttlMilliseconds: 10,
    });
    const expiring = broker.issue(
      'actor-a',
      'render',
      { input: {}, queryName: 'example' },
      {
        data: ['Never returned'],
        view: {
          bindings: { rows: '$result' },
          commands: [],
          kind: 'table',
          schemaVersion: 'datagram/view@1',
          title: 'Never returned',
        },
      },
      async () => {
        throw new Error('Stored value: Never returned');
      },
    );
    const sourceFailure = await broker
      .consume('service-a', 'actor-a', expiring.id, 'render')
      .catch((error: unknown) => error as DatagramError);
    expect(JSON.stringify(sourceFailure)).not.toContain('Never returned');
    expect(sourceFailure).toMatchObject({
      code: 'result-handle.source-unavailable',
      message: 'Result Handle source authorization is no longer valid',
    });
    now += 10;
    await expect(
      broker.consume('service-a', 'actor-a', expiring.id, 'render'),
    ).rejects.toMatchObject({
      code: 'result-handle.expired',
      message: 'Result Handle is missing or expired',
    } satisfies Partial<DatagramError>);
  });

  test('filters, groups, aggregates, and passes without leaking derived values', async () => {
    const value = await runtime();
    const { categoryId, channelId } = await table(value);
    const source = await value.app.prepareQuery(
      value.owner.id,
      'agent',
      'table.records.list',
      { channelId },
      'compose.filter',
    );
    const preview = await value.app.prepareQuery(
      value.owner.id,
      'agent',
      'table.field.conversion.preview',
      { channelId, fieldId: categoryId, targetType: 'number' },
    );
    const filtered = await value.app.composeResultHandle(value.owner.id, {
      handleId: source.id,
      inputPurpose: 'compose.filter',
      outputPurpose: 'compose.group',
      transform: {
        filters: [{ field: 'category', operator: 'equals', value: 'Hidden North' }],
        kind: 'filter',
      },
    });
    const grouped = await value.app.composeResultHandle(value.owner.id, {
      handleId: filtered.id,
      inputPurpose: 'compose.group',
      outputPurpose: 'compose.aggregate',
      transform: { fields: ['category'], kind: 'group' },
    });
    const aggregated = await value.app.composeResultHandle(value.owner.id, {
      handleId: grouped.id,
      inputPurpose: 'compose.aggregate',
      outputPurpose: 'compose.pass',
      transform: {
        aggregations: [
          { as: 'Secret Count', operator: 'count' },
          { as: 'Secret Total', field: 'amount', operator: 'sum' },
        ],
        kind: 'aggregate',
      },
    });
    const passed = await value.app.composeResultHandle(value.owner.id, {
      handleId: aggregated.id,
      inputPurpose: 'compose.pass',
      outputPurpose: 'trusted.render',
      transform: { kind: 'pass' },
    });

    for (const handle of [source, preview, filtered, grouped, aggregated, passed]) {
      const agentOutput = JSON.stringify(handle);
      for (const forbidden of [
        'Classified Revenue',
        'Secret Category',
        'Secret Amount',
        'Hidden North',
        'Hidden South',
        'Secret Count',
        'Secret Total',
      ]) {
        expect(agentOutput).not.toContain(forbidden);
      }
      expect(handle).not.toHaveProperty('data');
      expect(handle.view).not.toHaveProperty('title');
    }
    expect(
      (await value.app.consumeResultHandle(value.owner.id, passed.id, 'trusted.render')).data,
    ).toEqual([{ category: 'Hidden North', 'Secret Count': 2, 'Secret Total': 20 }]);
  });

  test('sanitizes unexpected Agent Query errors before they reach model context', async () => {
    const value = await runtime();
    Object.defineProperty(value.app.queries, 'execute', {
      value: async () => {
        throw new Error('Stored label: Classified Revenue; derived count: 3');
      },
    });

    const error = (await value.app
      .prepareQuery(value.owner.id, 'agent', 'table.records.list', {})
      .catch((failure: unknown) => failure)) as DatagramError;
    expect(error).toMatchObject({
      code: 'agent-query.failed',
      message: 'Agent Query could not be prepared',
      status: 500,
    });
    expect(error.message).not.toContain('Classified Revenue');
    expect(error.message).not.toContain('3');
  });

  test('reopens durable query definitions with fresh handles and current values', async () => {
    const value = await runtime();
    const { amountId, categoryId, channelId } = await table(value);
    await value.app.executeAction(value.owner.id, 'cli', 'table.view.create', {
      channelId,
      filters: [{ fieldId: categoryId, operator: 'equals', value: 'Hidden North' }],
      grouping: [categoryId],
      name: 'Secret North View',
      sorting: [{ direction: 'ascending', fieldId: amountId }],
      visibility: 'personal',
      visibleFieldIds: [categoryId, amountId],
    });
    const [view] = await value.store.listTableViews(channelId, value.owner.id);
    expect(view).toBeDefined();
    const definition = {
      input: { channelId, viewId: view!.id },
      purpose: 'data-view.render',
      queryName: 'table.view.open',
    } as const;
    const first = await value.app.reopenDataView(value.owner.id, 'agent', definition);
    await value.app.executeAction(value.owner.id, 'agent', 'table.record.create', {
      channelId,
      values: { amount: 5, category: 'Hidden North' },
    });
    const second = await value.app.reopenDataView(value.owner.id, 'agent', definition);

    expect(second.id).not.toBe(first.id);
    expect(JSON.stringify(first)).not.toContain('Secret North View');
    const result = await value.app.consumeResultHandle(
      value.owner.id,
      second.id,
      'data-view.render',
    );
    expect(JSON.stringify(result.data)).toContain('Hidden North');
    expect(JSON.stringify(result.data)).toContain('5');
  });

  test('keeps prompt-supplied Action values on the shared Action to Operation path', async () => {
    const value = await runtime();
    const { channelId } = await table(value);
    const receipt = await value.app.executeAction(value.owner.id, 'agent', 'table.record.create', {
      channelId,
      values: { amount: 99, category: 'Prompt supplied' },
    });
    expect(receipt.operationId).toStartWith('operation_');
    expect((await value.store.getTableRecord(receipt.subject!.id))?.values).toEqual({
      amount: 99,
      category: 'Prompt supplied',
    });
  });
});
