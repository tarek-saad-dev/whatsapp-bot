/**
 * Offer Audience Builder Service
 * Builds target audience from SQL Server based on offer targeting rules
 * 
 * UPDATED: Uses TblinvServHead with ClientID join (not TblInvServDetail with name parsing)
 */

const offerModel = require('../models/offer');
const targetingRuleModel = require('../models/offerTargetingRule');
const audienceModel = require('../models/offerAudience');
const database = require('./database');

/**
 * Build SQL WHERE clause for non-aggregated filters (before GROUP BY)
 * @param {Array} rules - Array of targeting rules
 * @param {object} offer - Offer object (for age requirements)
 * @returns {string} SQL WHERE clause
 */
function buildWhereClause(rules, offer) {
    const conditions = [];
    
    // Add offer-level age requirements if present
    // Note: Age filtering is now done in HAVING clause after GROUP BY
    // This WHERE clause is kept for any non-aggregated filters if needed
    
    // Add rule-based WHERE conditions (non-aggregated, before grouping)
    if (rules && rules.length > 0) {
        const ruleConditions = [];
        
        rules.forEach(rule => {
            const ruleWhereConditions = [];
            
            // City - using CameFrom
            if (rule.city) {
                ruleWhereConditions.push(`c.CameFrom = '${rule.city.replace(/'/g, "''")}'`);
            }
            
            // MaritalStatus - from State field
            if (rule.maritalStatus) {
                ruleWhereConditions.push(`c.State = '${rule.maritalStatus.replace(/'/g, "''")}'`);
            }
            
            // CameFrom
            if (rule.cameFrom) {
                ruleWhereConditions.push(`c.CameFrom = '${rule.cameFrom.replace(/'/g, "''")}'`);
            }
            
            // Gender - if field exists (may not be in schema)
            if (rule.gender) {
                // Note: Gender field may not exist, skip if not applicable
                // Uncomment if Gender field exists in TblClient:
                // ruleWhereConditions.push(`c.Gender = '${rule.gender.replace(/'/g, "''")}'`);
            }
            
            if (ruleWhereConditions.length > 0) {
                ruleConditions.push(`(${ruleWhereConditions.join(' AND ')})`);
            }
        });
        
        if (ruleConditions.length > 0) {
            // OR logic: client matches if any rule's WHERE conditions match
            conditions.push(`(${ruleConditions.join(' OR ')})`);
        }
    }
    
    if (conditions.length === 0) {
        return '';
    }
    
    return `WHERE ${conditions.join(' AND ')}`;
}

/**
 * Build SQL HAVING clause for aggregated filters (after GROUP BY)
 * @param {Array} rules - Array of targeting rules
 * @param {object} offer - Offer object (for age requirements)
 * @returns {string} SQL HAVING clause
 */
function buildHavingClause(rules, offer) {
    const conditions = [];
    
    // Age filtering (calculated after grouping)
    if (offer.minAge || offer.maxAge) {
        if (offer.minAge && offer.maxAge) {
            conditions.push(`DATEDIFF(year, c.BirthDate, GETDATE()) BETWEEN ${offer.minAge} AND ${offer.maxAge}`);
        } else if (offer.minAge) {
            conditions.push(`DATEDIFF(year, c.BirthDate, GETDATE()) >= ${offer.minAge}`);
        } else if (offer.maxAge) {
            conditions.push(`DATEDIFF(year, c.BirthDate, GETDATE()) <= ${offer.maxAge}`);
        }
    }
    
    // Rule-based HAVING conditions (aggregated filters)
    if (rules && rules.length > 0) {
        const ruleConditions = [];
        
        rules.forEach(rule => {
            const ruleHavingConditions = [];
            
            // Min Visits (aggregated)
            if (rule.minVisits !== null && rule.minVisits !== undefined) {
                ruleHavingConditions.push(`COUNT(h.invID) >= ${rule.minVisits}`);
            }
            
            // Min Spend (aggregated)
            if (rule.minSpend !== null && rule.minSpend !== undefined) {
                ruleHavingConditions.push(`ISNULL(SUM(h.GrandTotal), 0) >= ${rule.minSpend}`);
            }
            
            // Last Visit Date Range (aggregated - MAX date)
            if (rule.lastVisitFrom || rule.lastVisitTo) {
                if (rule.lastVisitFrom && rule.lastVisitTo) {
                    ruleHavingConditions.push(`MAX(h.invDate) BETWEEN '${rule.lastVisitFrom}' AND '${rule.lastVisitTo}'`);
                } else if (rule.lastVisitFrom) {
                    ruleHavingConditions.push(`MAX(h.invDate) >= '${rule.lastVisitFrom}'`);
                } else if (rule.lastVisitTo) {
                    ruleHavingConditions.push(`MAX(h.invDate) <= '${rule.lastVisitTo}'`);
                }
            }
            
            if (ruleHavingConditions.length > 0) {
                ruleConditions.push(`(${ruleHavingConditions.join(' AND ')})`);
            }
        });
        
        if (ruleConditions.length > 0) {
            // OR logic: client matches if any rule's HAVING conditions match
            conditions.push(`(${ruleConditions.join(' OR ')})`);
        }
    }
    
    if (conditions.length === 0) {
        return '';
    }
    
    return conditions.join(' AND ');
}

/**
 * Build SQL query to get matching clients
 * Uses TblinvServHead with ClientID join (correct structure)
 * @param {string} offerId - Offer ID
 * @param {Array} rules - Targeting rules
 * @param {object} offer - Offer object
 * @returns {string} SQL query
 */
function buildAudienceQuery(offerId, rules, offer) {
    const whereClause = buildWhereClause(rules, offer);
    const havingClause = buildHavingClause(rules, offer);
    
    // Correct query structure using TblinvServHead with ClientID join
    // TblClient: ClientID, Name, Mobile, BirthDate, State, CameFrom, RegisterDate
    // TblinvServHead: ClientID, invID, invDate, GrandTotal
    const query = `
        SELECT 
            c.ClientID as clientId,
            c.Mobile as phone,
            c.Name as name,
            DATEDIFF(year, c.BirthDate, GETDATE()) as age,
            c.State as maritalStatus,
            c.CameFrom as cameFrom,
            c.BirthDate as birthDate,
            c.RegisterDate as registerDate,
            COUNT(h.invID) as visitCount,
            ISNULL(SUM(h.GrandTotal), 0) as totalSpend,
            MAX(h.invDate) as lastVisitDate
        FROM TblClient c
        LEFT JOIN TblinvServHead h
            ON c.ClientID = h.ClientID
        ${whereClause}
        GROUP BY 
            c.ClientID,
            c.Mobile,
            c.Name,
            c.BirthDate,
            c.State,
            c.CameFrom,
            c.RegisterDate
        ${havingClause ? `HAVING ${havingClause}` : ''}
        ORDER BY c.ClientID
    `;
    
    return query.trim();
}

/**
 * Build audience for an offer
 * @param {string} offerId - Offer ID
 * @returns {Promise<object>} Build result
 */
async function buildOfferAudience(offerId) {
    try {
        console.log(`🚀 Building audience for offer: ${offerId}`);
        
        // Get offer
        const offer = offerModel.getOfferById(offerId);
        if (!offer) {
            throw new Error(`Offer not found: ${offerId}`);
        }
        
        // Get targeting rules
        const rules = targetingRuleModel.getTargetingRulesByOfferId(offerId);
        
        if (rules.length === 0) {
            console.log('⚠️  No targeting rules found. Returning empty audience.');
            return {
                offerId,
                offerName: offer.name,
                rulesCount: 0,
                audienceCount: 0,
                members: [],
                message: 'No targeting rules defined for this offer'
            };
        }
        
        // Build and execute SQL query
        const query = buildAudienceQuery(offerId, rules, offer);
        console.log('📊 Executing SQL query...');
        console.log('Query:', query);
        
        const results = await database.executeQuery(query);
        console.log(`✅ Found ${results.length} matching client(s)`);
        
        // Save to OfferAudience table
        const members = results.map(row => ({
            offerId,
            clientId: row.clientId?.toString() || row.ClientID?.toString() || '',
            phone: row.phone || row.Mobile || ''
        }));
        
        // Clear existing audience for this offer
        audienceModel.deleteAudienceByOfferId(offerId);
        
        // Add new audience members
        const { added, updated, total } = audienceModel.bulkAddAudienceMembers(members);
        
        console.log(`✅ Audience built: ${added.length} new, ${updated.length} updated, ${total} total`);
        
        return {
            offerId,
            offerName: offer.name,
            rulesCount: rules.length,
            audienceCount: results.length,
            members: results.map(row => ({
                clientId: row.clientId || row.ClientID,
                phone: row.phone || row.Mobile,
                name: row.name || row.Name,
                age: row.age,
                maritalStatus: row.maritalStatus || row.State,
                cameFrom: row.cameFrom || row.CameFrom,
                visitCount: row.visitCount,
                totalSpend: row.totalSpend,
                lastVisitDate: row.lastVisitDate
            })),
            message: `Successfully built audience with ${results.length} matching clients`
        };
    } catch (error) {
        console.error('❌ Error building audience:', error);
        throw error;
    }
}

/**
 * Get audience preview with names from SQL Server
 * @param {Array} audienceMembers - Array of audience member objects with clientId
 * @param {number} limit - Maximum number of records to return
 * @returns {Promise<Array>} Array of preview objects with name and phone
 */
async function getAudiencePreview(audienceMembers, limit = 5) {
    if (!audienceMembers || audienceMembers.length === 0) {
        return [];
    }
    
    try {
        const clientIds = audienceMembers
            .slice(0, limit)
            .map(m => m.clientId)
            .filter(id => id);
        
        if (clientIds.length === 0) {
            return [];
        }
        
        // Create parameterized query
        const params = {};
        const placeholders = clientIds.map((id, index) => {
            const paramName = `clientId${index}`;
            params[paramName] = id;
            return `@${paramName}`;
        }).join(', ');
        
        const query = `
            SELECT 
                c.ClientID as clientId,
                c.Name as name,
                c.Mobile as phone
            FROM TblClient c
            WHERE c.ClientID IN (${placeholders})
            ORDER BY c.ClientID
        `;
        
        const results = await database.executeQuery(query, params);
        
        return results.map(row => ({
            clientId: row.clientId || row.ClientID,
            name: row.name || row.Name || 'Unknown',
            phone: row.phone || row.Mobile || ''
        }));
    } catch (error) {
        console.error('❌ Error getting audience preview from SQL:', error.message);
        throw error;
    }
}

module.exports = {
    buildOfferAudience,
    getAudiencePreview,
    buildAudienceQuery // Exported for testing
};
