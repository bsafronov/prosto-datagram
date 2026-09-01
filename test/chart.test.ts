import { afterEach, describe, expect, test } from 'bun:test';

import { DatagramError } from '../src/packages/application/errors';
import { createRuntime, type DatagramRuntime } from '../src/packages/runtime';
import { renderView } from '../src/packages/view-host';

const openRuntimes: DatagramRuntime[] = [];

async function runtime() {
  const value = await createRuntime({ databasePath: ':memory:' });
  openRuntimes.push(value);
  return value;
}

async function source(value: DatagramRuntime) {
  const table = await value.app.executeAction(value.owner.id, 'cli', 'channel.create', {
    title: 'Private revenue',
    typeId: 'table',
  });
  const channelId = table.subject!.id;
  for (const field of [
    { key: 'region', label: 'Private region', type: 'text' },
    { key: 'amount', label: 'Private amount', type: 'number' },
  ] as const) {
    await value.app.executeAction(value.owner.id, 'cli', 'table.field.add', {
      channelId,
      ...field,
      required: true,
      unique: false,
    });
  }
  for (const values of [
    { amount: 10, region: 'Hidden North' },
    { amount: 5, region: 'Hidden North' },
    { amount: 20, region: 'Hidden South' },
  ]) {
    await value.app.executeAction(value.owner.id, 'cli', 'table.record.create', {
      channelId,
      values,
    });
  }
  return channelId;
}

async function chart(value: DatagramRuntime, sourceChannelId: string) {
  const sourceHandle = await value.app.prepareQuery(
    value.owner.id,
    'agent',
    'table.records.list',
    { channelId: sourceChannelId },
    'chart.filter',
  );
  const filtered = await value.app.composeResultHandle(value.owner.id, {
    handleId: sourceHandle.id,
    inputPurpose: 'chart.filter',
    outputPurpose: 'chart.group',
    transform: {
      filters: [{ field: 'region', operator: 'equals', value: 'Hidden North' }],
      kind: 'filter',
    },
  });
  const grouped = await value.app.composeResultHandle(value.owner.id, {
    handleId: filtered.id,
    inputPurpose: 'chart.group',
    outputPurpose: 'chart.aggregate',
    transform: { fields: ['region'], kind: 'group' },
  });
  const aggregated = await value.app.composeResultHandle(value.owner.id, {
    handleId: grouped.id,
    inputPurpose: 'chart.aggregate',
    outputPurpose: 'chart.create',
    transform: {
      aggregations: [
        { as: 'count', operator: 'count' },
        { as: 'total', field: 'amount', operator: 'sum' },
      ],
      kind: 'aggregate',
    },
  });
  const created = await value.app.executeAction(value.owner.id, 'agent', 'chart.create', {
    handleId: aggregated.id,
    presentation: { categoryField: 'region', series: ['total'], type: 'bar' },
    title: 'Live private revenue',
  });
  return { channelId: created.subject!.id, handleId: aggregated.id };
}

afterEach(async () => {
  await Promise.all(openRuntimes.splice(0).map((value) => value.close()));
});

describe('live Chart Channel', () => {
  test('stores a live query definition from a compatible Handle and renders current values', async () => {
    const value = await runtime();
    const sourceChannelId = await source(value);
    const created = await chart(value, sourceChannelId);
    const definition = await value.store.getChartDefinition(created.channelId);

    expect(definition).toEqual({
      aggregations: [
        { as: 'count', operator: 'count' },
        { as: 'total', field: 'amount', operator: 'sum' },
      ],
      channelId: created.channelId,
      filters: [{ field: 'region', operator: 'equals', value: 'Hidden North' }],
      grouping: ['region'],
      presentation: { categoryField: 'region', series: ['total'], type: 'bar' },
      sourceChannelId,
      version: 1,
    });
    expect(JSON.stringify(definition)).not.toContain(created.handleId);

    await value.app.executeAction(value.owner.id, 'cli', 'table.record.create', {
      channelId: sourceChannelId,
      values: { amount: 7, region: 'Hidden North' },
    });
    const result = await value.app.executeQuery(value.owner.id, 'cli', 'chart.open', {
      channelId: created.channelId,
    });
    expect(result.data).toEqual({
      presentation: { categoryField: 'region', series: ['total'], type: 'bar' },
      series: [{ count: 3, region: 'Hidden North', total: 22 }],
    });
    expect(renderView(result)).toMatchObject({
      fallback: false,
      kind: 'chart',
      semanticKind: 'chart',
      values: {
        presentation: { categoryField: 'region', series: ['total'], type: 'bar' },
        series: [{ count: 3, region: 'Hidden North', total: 22 }],
      },
    });

    const agentHandle = await value.app.prepareQuery(
      value.owner.id,
      'agent',
      'chart.open',
      { channelId: created.channelId },
      'chart.render',
    );
    const serialized = JSON.stringify(agentHandle);
    for (const forbidden of ['Live private revenue', 'Hidden North', '22']) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(agentHandle).not.toHaveProperty('data');
    expect(agentHandle.view).toEqual({
      bindings: { presentation: '$result.presentation', series: '$result.series' },
      commands: ['chart.definition.update', 'chart.event.record'],
      kind: 'chart',
      schemaVersion: 'datagram/view@1',
    });
  });

  test('rechecks source permission and emits Chart Activity only for Chart meaning', async () => {
    const value = await runtime();
    const sourceChannelId = await source(value);
    const created = await chart(value, sourceChannelId);
    const initial = await value.store.listActivities(created.channelId);

    await value.app.executeAction(value.owner.id, 'cli', 'table.record.create', {
      channelId: sourceChannelId,
      values: { amount: 1, region: 'Hidden North' },
    });
    expect(await value.store.listActivities(created.channelId)).toHaveLength(initial.length);

    await value.app.executeAction(value.owner.id, 'cli', 'chart.definition.update', {
      aggregations: [{ as: 'total', field: 'amount', operator: 'sum' }],
      channelId: created.channelId,
      filters: [],
      grouping: ['region'],
      observedVersion: 1,
      presentation: { categoryField: 'region', series: ['total'], type: 'line' },
      sourceChannelId,
    });
    await value.app.executeAction(value.owner.id, 'cli', 'chart.event.record', {
      channelId: created.channelId,
      kind: 'threshold',
    });
    expect((await value.store.listActivities(created.channelId)).slice(-2).map(({ kind }) => kind))
      .toEqual(['chart.definition-changed', 'chart.threshold-crossed']);

    const viewer = await value.app.executeAction(value.owner.id, 'cli', 'service.person.create', {
      displayName: 'Chart-only viewer',
    });
    await value.app.executeAction(value.owner.id, 'cli', 'channel.member.grant', {
      channelId: created.channelId,
      personId: viewer.subject!.id,
      role: 'viewer',
    });
    await expect(
      value.app.executeQuery(viewer.subject!.id, 'cli', 'chart.open', {
        channelId: created.channelId,
      }),
    ).rejects.toMatchObject({
      code: 'permission.denied',
    } satisfies Partial<DatagramError>);
  });

  test('rejects non-aggregate Handles without creating a Chart', async () => {
    const value = await runtime();
    const sourceChannelId = await source(value);
    const handle = await value.app.prepareQuery(
      value.owner.id,
      'agent',
      'table.records.list',
      { channelId: sourceChannelId },
      'chart.create',
    );
    const before = await value.store.listChannels(value.owner.id);
    await expect(
      value.app.executeAction(value.owner.id, 'agent', 'chart.create', {
        handleId: handle.id,
        presentation: { series: ['count'], type: 'bar' },
        title: 'Invalid Chart',
      }),
    ).rejects.toMatchObject({
      code: 'chart.result-handle-incompatible',
    } satisfies Partial<DatagramError>);
    expect(await value.store.listChannels(value.owner.id)).toHaveLength(before.length);
  });

  test('fixes Chart creation purpose and blocks definitionless generic Charts', async () => {
    const value = await runtime();
    const sourceChannelId = await source(value);
    const spoofed = await value.app.prepareQuery(
      value.owner.id,
      'agent',
      'table.records.list',
      { channelId: sourceChannelId },
      'attacker-controlled',
    );
    const before = await value.store.listChannels(value.owner.id);

    await expect(
      value.app.executeAction(value.owner.id, 'agent', 'chart.create', {
        handleId: spoofed.id,
        presentation: { series: ['count'], type: 'bar' },
        title: 'Spoofed Chart',
      }),
    ).rejects.toMatchObject({
      code: 'result-handle.purpose-mismatch',
    } satisfies Partial<DatagramError>);
    await expect(
      value.app.executeAction(value.owner.id, 'cli', 'channel.create', {
        title: 'Definitionless Chart',
        typeId: 'chart',
      }),
    ).rejects.toMatchObject({
      code: 'chart.definition-required',
    } satisfies Partial<DatagramError>);
    expect(await value.store.listChannels(value.owner.id)).toHaveLength(before.length);
  });

  test('rejects type-incompatible aggregations and filters atomically', async () => {
    const value = await runtime();
    const sourceChannelId = await source(value);
    const beforeCreate = await value.store.listChannels(value.owner.id);

    const aggregationSource = await value.app.prepareQuery(
      value.owner.id,
      'agent',
      'table.records.list',
      { channelId: sourceChannelId },
      'invalid.aggregate',
    );
    const invalidAggregation = await value.app.composeResultHandle(value.owner.id, {
      handleId: aggregationSource.id,
      inputPurpose: 'invalid.aggregate',
      outputPurpose: 'chart.create',
      transform: {
        aggregations: [{ as: 'total', field: 'region', operator: 'sum' }],
        kind: 'aggregate',
      },
    });
    await expect(
      value.app.executeAction(value.owner.id, 'agent', 'chart.create', {
        handleId: invalidAggregation.id,
        presentation: { series: ['total'], type: 'bar' },
        title: 'Invalid aggregation',
      }),
    ).rejects.toMatchObject({
      code: 'chart.definition-invalid-aggregation',
    } satisfies Partial<DatagramError>);

    const filterSource = await value.app.prepareQuery(
      value.owner.id,
      'agent',
      'table.records.list',
      { channelId: sourceChannelId },
      'invalid.filter',
    );
    const invalidFilter = await value.app.composeResultHandle(value.owner.id, {
      handleId: filterSource.id,
      inputPurpose: 'invalid.filter',
      outputPurpose: 'invalid.filter.aggregate',
      transform: {
        filters: [{ field: 'amount', operator: 'contains', value: '10' }],
        kind: 'filter',
      },
    });
    const filteredAggregate = await value.app.composeResultHandle(value.owner.id, {
      handleId: invalidFilter.id,
      inputPurpose: 'invalid.filter.aggregate',
      outputPurpose: 'chart.create',
      transform: {
        aggregations: [{ as: 'count', operator: 'count' }],
        kind: 'aggregate',
      },
    });
    await expect(
      value.app.executeAction(value.owner.id, 'agent', 'chart.create', {
        handleId: filteredAggregate.id,
        presentation: { series: ['count'], type: 'bar' },
        title: 'Invalid filter',
      }),
    ).rejects.toMatchObject({
      code: 'chart.definition-invalid-filter',
    } satisfies Partial<DatagramError>);
    expect(await value.store.listChannels(value.owner.id)).toHaveLength(beforeCreate.length);

    const created = await chart(value, sourceChannelId);
    const beforeUpdate = await value.store.listActivities(created.channelId);
    await expect(
      value.app.executeAction(value.owner.id, 'cli', 'chart.definition.update', {
        aggregations: [{ as: 'total', field: 'region', operator: 'maximum' }],
        channelId: created.channelId,
        filters: [],
        grouping: [],
        observedVersion: 1,
        presentation: { series: ['total'], type: 'bar' },
        sourceChannelId,
      }),
    ).rejects.toMatchObject({
      code: 'chart.definition-invalid-aggregation',
    } satisfies Partial<DatagramError>);
    await expect(
      value.app.executeAction(value.owner.id, 'cli', 'chart.definition.update', {
        aggregations: [{ as: 'count', operator: 'count' }],
        channelId: created.channelId,
        filters: [{ field: 'region', operator: 'greater-than', value: 5 }],
        grouping: [],
        observedVersion: 1,
        presentation: { series: ['count'], type: 'bar' },
        sourceChannelId,
      }),
    ).rejects.toMatchObject({
      code: 'chart.definition-invalid-filter',
    } satisfies Partial<DatagramError>);
    expect((await value.store.getChartDefinition(created.channelId))?.version).toBe(1);
    expect(await value.store.listActivities(created.channelId)).toHaveLength(beforeUpdate.length);
  });
});
