import { describe, it, expect } from 'vitest';
import salesRouter from '../../routes/sales.js';

const { formatMessage } = salesRouter;

describe('formatMessage', () => {
  it('replaces all supported placeholders from sale data', () => {
    const message = formatMessage(
      'Hello {{customerName}}, order {{orderId}} is {{amount}} {{currency}} on {{date}} at {{time}}. Items: {{items}}, paid by {{paymentMethod}}. Service: {{service}}. Reservation: {{reservationId}}',
      {
        customerName: 'Alice',
        orderId: 'ORD-123',
        amount: '150.00',
        currency: 'EGP',
        date: '2026-01-15',
        time: '02:30 PM',
        items: '3',
        paymentMethod: 'Card',
        service: 'Haircut',
        reservationId: 'R-001'
      },
      'sale'
    );

    expect(message).toContain('Alice');
    expect(message).toContain('ORD-123');
    expect(message).toContain('150.00');
    expect(message).toContain('EGP');
    expect(message).toContain('2026-01-15');
    expect(message).toContain('02:30 PM');
    expect(message).toContain('3');
    expect(message).toContain('Card');
    expect(message).toContain('Haircut');
    expect(message).toContain('R-001');
  });

  it('uses a custom template when provided', () => {
    const message = formatMessage('Hi {{customerName}}, your order {{orderId}} is ready', {
      customerName: 'Bob',
      orderId: '42'
    }, 'sale');

    expect(message).toBe('Hi Bob, your order 42 is ready');
  });

  it('falls back to defaults for missing fields', () => {
    const message = formatMessage('Hello {{customerName}}', {}, 'sale');
    expect(message).toContain('Customer');
  });

  it('can format a booking template', () => {
    const message = formatMessage(
      'Booking for {{customerName}} on {{date}} at {{time}}. Service: {{service}}. Reservation: {{reservationId}}',
      {
        customerName: 'Carol',
        date: '2026-02-01',
        time: '10:00 AM',
        service: 'Coloring',
        reservationId: 'R-999'
      },
      'booking'
    );

    expect(message).toContain('Carol');
    expect(message).toContain('2026-02-01');
    expect(message).toContain('10:00 AM');
    expect(message).toContain('Coloring');
    expect(message).toContain('R-999');
  });
});
