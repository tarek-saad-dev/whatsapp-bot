import { describe, it, expect, beforeEach } from 'vitest';
import * as customerModel from '../../models/customer.js';
import * as segmentation from '../../services/segmentation.js';
import * as audienceBuilder from '../../services/offerAudienceBuilder.js';
import { resetTestData } from '../utils/test-helpers.js';

const today = new Date().toISOString().split('T')[0];
const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
const lastWeek = new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0];
const lastMonth = new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];

describe('segmentation', () => {
  beforeEach(() => {
    resetTestData();
  });

  it('selects customers who visited today', () => {
    customerModel.addCustomer({ phone: '201234567890', name: 'Today', lastVisitDate: today });
    customerModel.addCustomer({ phone: '201000111222', name: 'Yesterday', lastVisitDate: yesterday });

    const customers = segmentation.getCustomersBySegment('today');
    expect(customers.map(c => c.name)).toContain('Today');
    expect(customers.map(c => c.name)).not.toContain('Yesterday');
  });

  it('selects customers who visited this week', () => {
    customerModel.addCustomer({ phone: '201234567890', name: 'Today', lastVisitDate: today });
    customerModel.addCustomer({ phone: '201000111222', name: 'LastWeek', lastVisitDate: lastWeek });
    customerModel.addCustomer({ phone: '201333444555', name: 'LastMonth', lastVisitDate: lastMonth });

    const customers = segmentation.getCustomersBySegment('this_week');
    const names = customers.map(c => c.name);
    expect(names).toContain('Today');
    expect(names).toContain('LastWeek');
    expect(names).not.toContain('LastMonth');
  });

  it('returns phone numbers only for a segment', () => {
    customerModel.addCustomer({ phone: '201234567890', name: 'Alice', lastVisitDate: today });
    expect(segmentation.getPhoneNumbersBySegment('today')).toEqual(['201234567890']);
  });

  it('returns empty arrays for unknown segments', () => {
    expect(segmentation.getCustomersBySegment('unknown')).toEqual([]);
  });
});

describe('offerAudienceBuilder', () => {
  beforeEach(() => {
    resetTestData();
  });

  it('builds an audience query without a where clause when no rules have city/marital/cameFrom', () => {
    const query = audienceBuilder.buildAudienceQuery('offer-1', [
      { minVisits: 2, minSpend: 100 }
    ], {});

    expect(query).toContain('FROM TblClient');
    expect(query).toContain('HAVING (COUNT(h.invID) >= 2 AND ISNULL(SUM(h.GrandTotal), 0) >= 100)');
  });

  it('includes city filter in the where clause', () => {
    const query = audienceBuilder.buildAudienceQuery('offer-1', [
      { city: 'Cairo' }
    ], {});

    expect(query).toContain("WHERE (c.CameFrom = 'Cairo')");
  });

  it('combines where and having conditions', () => {
    const query = audienceBuilder.buildAudienceQuery('offer-1', [
      { city: 'Alex', minVisits: 3 }
    ], {});

    expect(query).toContain("c.CameFrom = 'Alex'");
    expect(query).toContain('COUNT(h.invID) >= 3');
  });

  it('includes age range in the having clause', () => {
    const query = audienceBuilder.buildAudienceQuery('offer-1', [], { minAge: 18, maxAge: 35 });

    expect(query).toContain('DATEDIFF(year, c.BirthDate, GETDATE()) BETWEEN 18 AND 35');
  });

  it('escapes single quotes in string filters to prevent SQL injection', () => {
    const query = audienceBuilder.buildAudienceQuery('offer-1', [
      { city: "O'Brien" }
    ], {});

    expect(query).toContain("c.CameFrom = 'O''Brien'");
  });
});
