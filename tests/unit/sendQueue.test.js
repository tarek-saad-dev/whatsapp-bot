import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { createSendQueue } = require('../../services/sendQueue');
const { normalizeEgyptianPhone, chatIdFromNormalizedPhone } = require('../../services/phone');

describe('sendQueue concurrency=1', () => {
  it('1. single job runs once', async () => {
    const q = createSendQueue({ concurrency: 1 });
    let calls = 0;
    const result = await q.enqueue(async () => {
      calls += 1;
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(calls).toBe(1);
    expect(q.getStats().maxConcurrent).toBe(1);
  });

  it('2-4. two concurrent jobs never overlap sendMessage', async () => {
    const q = createSendQueue({ concurrency: 1 });
    q.resetStats();
    let concurrent = 0;
    let maxConcurrent = 0;
    const order = [];

    const job = (name, delayMs) =>
      q.enqueue(async () => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        order.push(`start:${name}`);
        await new Promise((r) => setTimeout(r, delayMs));
        order.push(`end:${name}`);
        concurrent -= 1;
        return name;
      });

    const [a, b] = await Promise.all([job('omar', 40), job('ziad', 40)]);
    expect([a, b].sort()).toEqual(['omar', 'ziad']);
    expect(maxConcurrent).toBe(1);
    expect(q.getStats().maxConcurrent).toBe(1);
    expect(order[0].startsWith('start:')).toBe(true);
    expect(order[1].startsWith('end:')).toBe(true);
    expect(order[2].startsWith('start:')).toBe(true);
    expect(order[3].startsWith('end:')).toBe(true);
  });

  it('5. first failure does not block second', async () => {
    const q = createSendQueue({ concurrency: 1 });
    const results = await Promise.allSettled([
      q.enqueue(async () => {
        throw new Error('boom');
      }),
      q.enqueue(async () => 'second-ok'),
    ]);
    expect(results[0].status).toBe('rejected');
    expect(results[1].status).toBe('fulfilled');
    expect(results[1].value).toBe('second-ok');
  });

  it('6. first success and second failure keep distinct outcomes', async () => {
    const q = createSendQueue({ concurrency: 1 });
    const results = await Promise.allSettled([
      q.enqueue(async () => ({ status: 'sent', messageId: 'm1' })),
      q.enqueue(async () => {
        throw new Error('fail-2');
      }),
    ]);
    expect(results[0].status).toBe('fulfilled');
    expect(results[0].value.messageId).toBe('m1');
    expect(results[1].status).toBe('rejected');
  });

  it('7. enqueue resolves only after task resolves (no early sent)', async () => {
    const q = createSendQueue({ concurrency: 1 });
    let finished = false;
    const p = q.enqueue(async () => {
      await new Promise((r) => setTimeout(r, 30));
      finished = true;
      return { status: 'sent', messageId: 'late' };
    });
    expect(finished).toBe(false);
    const result = await p;
    expect(finished).toBe(true);
    expect(result.status).toBe('sent');
  });
});

describe('fake WhatsApp client through queue', () => {
  it('3. maxConcurrentSends stays 1 for two parallel employee_sale jobs', async () => {
    const q = createSendQueue({ concurrency: 1 });
    q.resetStats();
    let concurrent = 0;
    let maxConcurrentSends = 0;
    const messageIds = [];

    const fakeClient = {
      async sendMessage(chatId, _message) {
        concurrent += 1;
        maxConcurrentSends = Math.max(maxConcurrentSends, concurrent);
        await new Promise((r) => setTimeout(r, 35));
        concurrent -= 1;
        const messageId = `wa-fake-${chatId}-${messageIds.length + 1}`;
        messageIds.push(messageId);
        return { id: messageId };
      },
      async isRegisteredUser(chatId) {
        return !String(chatId).includes('999999');
      },
    };

    async function sendEmployeeSale(originalPhone) {
      const normalizedPhone = normalizeEgyptianPhone(originalPhone);
      const chatId = chatIdFromNormalizedPhone(normalizedPhone);
      return q.enqueue(async () => {
        const registered = await fakeClient.isRegisteredUser(chatId);
        if (!registered) {
          return { ok: false, status: 'not_registered', phone: normalizedPhone };
        }
        const sent = await fakeClient.sendMessage(chatId, 'employee sale body');
        return {
          ok: true,
          status: 'sent',
          messageId: sent.id,
          phone: normalizedPhone,
        };
      });
    }

    const [omar, ziad] = await Promise.all([
      sendEmployeeSale('01227423337'),
      sendEmployeeSale('01039244023'),
    ]);

    expect(maxConcurrentSends).toBe(1);
    expect(q.getStats().maxConcurrent).toBe(1);
    expect(omar.status).toBe('sent');
    expect(ziad.status).toBe('sent');
    expect(omar.messageId).toBeTruthy();
    expect(ziad.messageId).toBeTruthy();
    expect(omar.messageId).not.toBe(ziad.messageId);
    expect(omar.phone).toBe('201227423337');
    expect(ziad.phone).toBe('201039244023');
  });

  it('10. unregistered number returns not_registered without send', async () => {
    const q = createSendQueue({ concurrency: 1 });
    let sends = 0;
    const fakeClient = {
      async sendMessage() {
        sends += 1;
        return { id: 'should-not-happen' };
      },
      async isRegisteredUser() {
        return false;
      },
    };

    const result = await q.enqueue(async () => {
      const phone = normalizeEgyptianPhone('01039244023');
      const chatId = chatIdFromNormalizedPhone(phone);
      if (!(await fakeClient.isRegisteredUser(chatId))) {
        return { ok: false, status: 'not_registered', phone };
      }
      const sent = await fakeClient.sendMessage(chatId, 'x');
      return { ok: true, status: 'sent', messageId: sent.id, phone };
    });

    expect(result.status).toBe('not_registered');
    expect(result.ok).toBe(false);
    expect(sends).toBe(0);
  });

  it('12. exception does not yield status sent', async () => {
    const q = createSendQueue({ concurrency: 1 });
    await expect(
      q.enqueue(async () => {
        throw new Error('chrome crash');
      }),
    ).rejects.toThrow('chrome crash');
  });
});

describe('Egyptian phone normalization', () => {
  it('8. 010 → 2010', () => {
    expect(normalizeEgyptianPhone('01039244023')).toBe('201039244023');
    expect(chatIdFromNormalizedPhone('201039244023')).toBe('201039244023@c.us');
  });

  it('9. 012 → 2012', () => {
    expect(normalizeEgyptianPhone('01227423337')).toBe('201227423337');
    expect(chatIdFromNormalizedPhone('201227423337')).toBe('201227423337@c.us');
  });

  it('rejects invalid numbers', () => {
    expect(normalizeEgyptianPhone('123')).toBeNull();
    expect(normalizeEgyptianPhone('02012345678')).toBeNull();
  });
});
