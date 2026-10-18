import test from 'node:test';
import assert from 'node:assert/strict';
import nodemailer from 'nodemailer';
import cron from 'node-cron';
import { v4 as uuidv4 } from 'uuid';

// These tests are deliberately offline: no SMTP delivery, scheduler start,
// SQLite open, model request, or agent-server startup occurs.
test('UUID provider generates valid v4 identifiers', () => {
  const id = uuidv4();
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
});

test('Node Cron supports the scheduler add/stop API without running a callback', () => {
  assert.equal(cron.validate('*/5 * * * *'), true);
  assert.equal(cron.validate('not-a-cron-expression'), false);
  assert.equal(typeof cron.schedule, 'function');
  const task = cron.schedule('*/5 * * * *', () => {
    assert.fail('the offline scheduler smoke test must not run a callback');
  });
  assert.equal(typeof task.stop, 'function');
  task.stop();
});

test('Nodemailer normalizes mail through JSON transport without network I/O', async () => {
  const transport = nodemailer.createTransport({
    jsonTransport: true,
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  const result = await transport.sendMail({
    from: 'gobi-smoke@example.invalid',
    to: 'sink@example.invalid',
    subject: 'offline dependency smoke test',
    text: 'This message is serialized only and must not be sent.',
  });
  assert.ok(result.message);
  assert.equal(result.envelope.to[0], 'sink@example.invalid');
});
