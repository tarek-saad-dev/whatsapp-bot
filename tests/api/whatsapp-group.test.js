import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createRequire } from 'module';
import { app } from '../../server.js';

const require = createRequire(import.meta.url);
const whatsappService = require('../../services/whatsappService');

describe('WhatsApp group send API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('POST /api/whatsapp/send-group', () => {
    it('rejects an empty body', async () => {
      const res = await request(app).post('/api/whatsapp/send-group').send({});

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('required');
    });

    it('rejects when both groupInviteLink and groupName are provided', async () => {
      const res = await request(app)
        .post('/api/whatsapp/send-group')
        .send({
          groupInviteLink: 'https://chat.whatsapp.com/AbCdEfGhIjK',
          groupName: 'Sales Team',
          message: 'hello',
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('not both');
    });

    it('rejects invalid invite link', async () => {
      const res = await request(app)
        .post('/api/whatsapp/send-group')
        .send({ groupInviteLink: 'not-a-link', message: 'hello' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('groupInviteLink is invalid');
    });

    it('rejects missing message', async () => {
      const res = await request(app)
        .post('/api/whatsapp/send-group')
        .send({ groupName: 'Sales Team' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('message is required');
    });

    it('sends to group by name', async () => {
      const sendGroupMessageAndWait = vi.spyOn(whatsappService, 'sendGroupMessageAndWait').mockResolvedValue({
        success: true,
        status: 'sent',
        messageId: 'wa-grp-test-1',
        target: 'Sales Team',
        chatId: 'group:Sales Team',
      });

      const res = await request(app)
        .post('/api/whatsapp/send-group')
        .send({ groupName: 'Sales Team', message: 'رسالة للجروب' });

      expect(res.status).toBe(200);
      expect(res.body.type).toBe('group');
      expect(res.body.target).toBe('Sales Team');
      expect(sendGroupMessageAndWait).toHaveBeenCalledWith(
        { groupName: 'Sales Team' },
        'رسالة للجروب',
        expect.any(Number),
        expect.objectContaining({
          logContext: expect.objectContaining({ type: 'group' }),
        }),
      );
    });

    it('sends to group by invite link', async () => {
      const sendGroupMessageAndWait = vi.spyOn(whatsappService, 'sendGroupMessageAndWait').mockResolvedValue({
        success: true,
        status: 'sent',
        messageId: 'wa-grp-test-2',
        target: 'https://chat.whatsapp.com/AbCdEfGhIjK',
        chatId: 'https://web.whatsapp.com/accept?code=AbCdEfGhIjK',
      });

      const res = await request(app)
        .post('/api/whatsapp/send-group')
        .send({
          groupInviteLink: 'https://chat.whatsapp.com/AbCdEfGhIjK',
          message: 'hello group',
        });

      expect(res.status).toBe(200);
      expect(sendGroupMessageAndWait).toHaveBeenCalledWith(
        { groupInviteLink: 'https://chat.whatsapp.com/AbCdEfGhIjK' },
        'hello group',
        expect.any(Number),
        expect.any(Object),
      );
    });

    it('returns 404 when group is not found', async () => {
      vi.spyOn(whatsappService, 'sendGroupMessageAndWait').mockResolvedValue({
        success: false,
        status: 'group_not_found',
        error: 'Group not found: Missing Group',
        target: 'Missing Group',
      });

      const res = await request(app)
        .post('/api/whatsapp/send-group')
        .send({ groupName: 'Missing Group', message: 'hello' });

      expect(res.status).toBe(404);
      expect(res.body.status).toBe('group_not_found');
    });
  });
});
