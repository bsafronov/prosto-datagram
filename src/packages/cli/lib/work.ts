import { join } from 'node:path';
import { z } from 'zod';
import type { DatagramApplicationPort } from '../../application/port';
import { DatagramError } from '../../application/errors';
import type { CliHost } from './host';
import { createAnswerReader, type ReadAnswer } from './prompts';
import { profileNamePattern } from './profiles';

export async function chooseWorkProfile(host: CliHost): Promise<string | undefined> {
  const directory = join(host.directories.configuration, 'profiles');
  const names =
    host.filesystem.listDirectory && (await host.filesystem.pathExists(directory))
      ? (await host.filesystem.listDirectory(directory))
          .filter((name) => name.endsWith('.json'))
          .map((name) => name.slice(0, -5))
          .filter((name) => profileNamePattern.test(name))
          .sort()
      : [];
  if (!names.length) {
    host.terminal.writeOutput('No Service profiles found. Run `datagram init` first.\n');
    return;
  }
  const answer = await createAnswerReader(host)({
    message: 'Choose a Service profile',
    choices: names.map((value) => ({ value, label: value })),
  });
  return names.includes(answer) ? answer : undefined;
}

const channelsSchema = z.array(z.object({ id: z.string(), title: z.string(), typeId: z.string() }));
const fieldsSchema = z.array(
  z.object({ key: z.string(), label: z.string(), type: z.string(), required: z.boolean() }),
);

type WorkApplication = Pick<DatagramApplicationPort, 'executeAction' | 'executeQuery'>;

async function createTable(host: CliHost, app: WorkApplication, actorId: string, read: ReadAnswer) {
  const cancelled = () => {
    host.terminal.writeOutput('Cancelled. No Table created.\n');
    return undefined;
  };
  let title = '';
  while (!title) {
    const answer = await read({ message: 'Name your Table' });
    if (answer === 'Cancel') return cancelled();
    title = answer.trim();
    if (!title) host.terminal.writeOutput('Enter a Table name.\n');
  }
  const fields: { key: string; label: string; type: string; required: boolean; unique: boolean }[] =
    [];
  while (true) {
    const label = await read({ message: 'Field name (for example Name or Amount)' });
    if (label === 'Cancel') return cancelled();
    if (!label.trim()) {
      host.terminal.writeOutput('Enter a Field name.\n');
      continue;
    }
    const type = await read({
      message: 'Field type',
      choices: [
        { value: 'text', label: 'Text' },
        { value: 'number', label: 'Number' },
        { value: 'boolean', label: 'Yes / No' },
        { value: 'date-time', label: 'Date and time' },
      ],
    });
    if (!['text', 'number', 'boolean', 'date-time'].includes(type)) return cancelled();
    const required = await read({ message: 'Require a value for this Field?', confirm: true });
    if (required === 'Cancel') return cancelled();
    fields.push({
      key: `field_${fields.length + 1}`,
      label: label.trim(),
      type,
      required: required === 'yes',
      unique: false,
    });
    const more = await read({ message: 'Add another Field?', confirm: true });
    if (more === 'Cancel') return cancelled();
    if (more !== 'yes') break;
  }
  const apply = await read({
    message: `Create Table ${title}?\n${fields.map((field) => `${field.label}: ${field.type}${field.required ? ' (required)' : ''}`).join('\n')}`,
    choices: [
      { value: 'create', label: 'Create Table' },
      { value: 'cancel', label: 'Cancel' },
    ],
  });
  if (apply !== 'create') return cancelled();
  const receipt = await app.executeAction(actorId, 'cli', 'channel.create', {
    title,
    typeId: 'table',
  });
  const id = receipt.subject?.id;
  if (!id) throw new Error('Table creation returned no Channel identity');
  let added = 0;
  try {
    for (const field of fields) {
      await app.executeAction(actorId, 'cli', 'table.field.add', { channelId: id, ...field });
      added++;
    }
  } catch (error) {
    host.terminal.writeOutput(
      `Table ${title} (${id}) was created with ${added} of ${fields.length} Fields. Keep this ID to finish its schema with table.field.add; do not create a duplicate Table.\n`,
    );
    throw error;
  }
  host.terminal.writeOutput(`Table created: ${title} (${id}). You can now add its first Record.\n`);
  return { id, title };
}

export async function runTableWork(
  host: CliHost,
  app: WorkApplication,
  actorId: string,
): Promise<void> {
  const read = createAnswerReader(host);
  const channels = channelsSchema
    .parse((await app.executeQuery(actorId, 'cli', 'channel.list', {})).data)
    .filter((channel) => channel.typeId === 'table');
  const selected = await read({
    message: 'Choose a Table',
    choices: [
      ...channels.map((channel) => ({
        value: channel.id,
        label: `${channel.title} (${channel.id})`,
      })),
      { value: 'create', label: 'Create a Table' },
    ],
  });
  const channel =
    selected === 'create'
      ? await createTable(host, app, actorId, read)
      : channels.find((channel) => channel.id === selected);
  if (!channel) return;
  const channelId = channel.id;
  const described = await app.executeQuery(actorId, 'cli', 'table.describe', { channelId });
  if (!described.view.commands.includes('table.record.create')) {
    host.terminal.writeOutput('You can view this Table but cannot add Records.\n');
    return;
  }
  const action = await read({
    message: 'What would you like to do?',
    choices: [
      { value: 'add', label: 'Add a Record' },
      { value: 'cancel', label: 'Cancel' },
    ],
  });
  if (action !== 'add') return;
  const fields = fieldsSchema.parse(described.data);
  if (fields.some((field) => !['text', 'number', 'boolean', 'date-time'].includes(field.type))) {
    host.terminal.writeOutput(
      'This Table has Dictionary or Record Reference fields. Use `datagram action table.record.create --input JSON` for now.\n',
    );
    return;
  }
  const values: Record<string, string | number | boolean> = {};
  let step = 0;
  while (true) {
    if (step < fields.length) {
      const field = fields[step]!;
      const answer = await read({
        message: `${field.label} (${field.type}${field.required ? ', required' : ', optional'}). Back to return; blank to use the default or omit.`,
        ...(field.type === 'boolean'
          ? {
              choices: [
                { value: 'true', label: 'Yes' },
                { value: 'false', label: 'No' },
                { value: '', label: 'Use default or omit' },
                { value: 'Back', label: 'Back' },
              ],
            }
          : {}),
      });
      if (answer === 'Cancel') {
        host.terminal.writeOutput('Cancelled. No Record saved.\n');
        return;
      }
      if (answer === 'Back') {
        step = Math.max(0, step - 1);
        continue;
      }
      if (answer === '') {
        delete values[field.key];
        step++;
        continue;
      }
      if (field.type === 'number' && (!answer.trim() || !Number.isFinite(Number(answer)))) {
        host.terminal.writeOutput('Enter a finite number.\n');
        continue;
      }
      if (
        field.type === 'date-time' &&
        !z.iso.datetime({ offset: true }).safeParse(answer).success
      ) {
        host.terminal.writeOutput(
          'Enter an ISO date-time with timezone, for example 2026-09-05T12:00:00Z.\n',
        );
        continue;
      }
      values[field.key] =
        field.type === 'number'
          ? Number(answer)
          : field.type === 'boolean'
            ? answer === 'true'
            : answer;
      step++;
      continue;
    }
    const choice = await read({
      message: `Review Record for ${channel.title}\n${JSON.stringify(values, null, 2)}`,
      initialValue: 'save',
      choices: [
        { value: 'save', label: 'Save Record' },
        { value: 'edit', label: 'Edit fields' },
        { value: 'cancel', label: 'Cancel' },
      ],
    });
    if (choice === 'edit') {
      step = 0;
      continue;
    }
    if (choice !== 'save') {
      host.terminal.writeOutput('Cancelled. No Record saved.\n');
      return;
    }
    let receipt;
    try {
      receipt = await app.executeAction(actorId, 'cli', 'table.record.create', {
        channelId,
        values,
      });
    } catch (error) {
      if (!(error instanceof DatagramError) || error.status >= 500) throw error;
      host.terminal.writeOutput(`Record was not saved: ${error.message}\n`);
      if (error.status === 403 || error.status === 404) return;
      step = 0;
      continue;
    }
    host.terminal.writeOutput(
      `Record saved. ID: ${receipt.subject?.id}; Operation: ${receipt.operationId}\n`,
    );
    return;
  }
}
