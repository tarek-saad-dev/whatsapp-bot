import { describe, it, expect } from 'vitest';
import { formatPhoneNumber } from '../../services/whatsappService.js';

describe('formatPhoneNumber', () => {
  it('replaces a leading 0 with the country code 20', () => {
    expect(formatPhoneNumber('01234567890')).toBe('201234567890');
  });

  it('keeps international numbers unchanged', () => {
    expect(formatPhoneNumber('201234567890')).toBe('201234567890');
  });

  it('does not change numbers that do not start with 0', () => {
    expect(formatPhoneNumber(1234567890)).toBe('1234567890');
  });

  it('handles empty string safely', () => {
    expect(formatPhoneNumber('')).toBe('');
  });
});
