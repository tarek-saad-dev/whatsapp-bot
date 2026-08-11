/**
 * Test Script for Audience Building Flow
 * 
 * This script tests the complete flow:
 * 1. Create an offer
 * 2. Add targeting rules
 * 3. Build audience
 * 4. Verify audience data
 * 
 * Run: node test-audience-building.js
 */

const API_BASE = 'http://localhost:3000/api/offers';

// Check if fetch is available (Node.js 18+)
if (typeof fetch === 'undefined') {
    console.error('❌ This script requires Node.js 18+ or install node-fetch');
    console.error('   Run: npm install node-fetch');
    process.exit(1);
}

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function testAudienceBuildingFlow() {
    console.log('🧪 Testing Complete Audience Building Flow');
    console.log('==========================================\n');

    let offerId = null;
    let ruleId = null;

    try {
        // Step 1: Create a new Offer
        console.log('1️⃣  Creating a new offer...');
        console.log('   POST', API_BASE);
        console.log('   Body:', JSON.stringify({
            name: 'Test Offer – July',
            status: 'draft',
            minAge: 18,
            maxAge: 40
        }, null, 2));
        console.log('');

        const createOfferResponse = await fetch(API_BASE, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: 'Test Offer – July',
                status: 'draft',
                minAge: 18,
                maxAge: 40
            })
        });

        if (!createOfferResponse.ok) {
            const error = await createOfferResponse.json();
            throw new Error(`Failed to create offer: ${error.error || JSON.stringify(error)}`);
        }

        const newOffer = await createOfferResponse.json();
        offerId = newOffer.id;
        
        console.log('✅ Offer created successfully!');
        console.log('   Offer ID:', offerId);
        console.log('   Name:', newOffer.name);
        console.log('   Status:', newOffer.status);
        console.log('   Age Range:', `${newOffer.minAge} - ${newOffer.maxAge}`);
        console.log('');

        // Step 2: Add targeting rules
        console.log('2️⃣  Adding targeting rules...');
        console.log('   POST', `${API_BASE}/${offerId}/targeting`);
        console.log('   Body:', JSON.stringify({
            cameFrom: 'ميامي',
            minVisits: 1,
            minSpend: 0
        }, null, 2));
        console.log('');

        const createRuleResponse = await fetch(`${API_BASE}/${offerId}/targeting`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                cameFrom: 'ميامي',
                minVisits: 1,
                minSpend: 0
            })
        });

        if (!createRuleResponse.ok) {
            const error = await createRuleResponse.json();
            throw new Error(`Failed to create targeting rule: ${error.error || JSON.stringify(error)}`);
        }

        const newRule = await createRuleResponse.json();
        ruleId = newRule.id;
        
        console.log('✅ Targeting rule created successfully!');
        console.log('   Rule ID:', ruleId);
        console.log('   CameFrom:', newRule.cameFrom);
        console.log('   MinVisits:', newRule.minVisits);
        console.log('   MinSpend:', newRule.minSpend);
        console.log('');

        // Step 3: Build the Audience
        console.log('3️⃣  Building audience from SQL Server...');
        console.log('   POST', `${API_BASE}/${offerId}/build-audience`);
        console.log('   ⏳ This may take a moment...');
        console.log('');

        const buildAudienceResponse = await fetch(`${API_BASE}/${offerId}/build-audience`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });

        if (!buildAudienceResponse.ok) {
            const error = await buildAudienceResponse.json();
            throw new Error(`Failed to build audience: ${error.error || JSON.stringify(error)}`);
        }

        const audienceResult = await buildAudienceResponse.json();
        
        console.log('✅ Audience built successfully!');
        console.log('   Success:', audienceResult.success);
        console.log('   Offer ID:', audienceResult.offerId);
        console.log('   Offer Name:', audienceResult.offerName);
        console.log('   Rules Count:', audienceResult.rulesCount);
        console.log('   Audience Count:', audienceResult.audienceCount);
        console.log('   Added:', audienceResult.added);
        console.log('   Updated:', audienceResult.updated);
        console.log('   Total:', audienceResult.total);
        console.log('   Message:', audienceResult.message);
        console.log('');

        // Display sample members if available
        if (audienceResult.members && audienceResult.members.length > 0) {
            console.log('   Sample members (first 5):');
            audienceResult.members.slice(0, 5).forEach((member, index) => {
                console.log(`   ${index + 1}. ClientID: ${member.clientId}, Phone: ${member.phone}, Name: ${member.name || 'N/A'}`);
                console.log(`      Visits: ${member.visitCount}, Total Spend: ${member.totalSpend}, Last Visit: ${member.lastVisitDate || 'N/A'}`);
            });
            if (audienceResult.members.length > 5) {
                console.log(`   ... and ${audienceResult.members.length - 5} more`);
            }
            console.log('');
        }

        // Step 4: Verify what was stored
        console.log('4️⃣  Verifying stored audience data...');
        console.log('   GET', `${API_BASE}/${offerId}/audience`);
        console.log('');

        const getAudienceResponse = await fetch(`${API_BASE}/${offerId}/audience`);
        
        if (!getAudienceResponse.ok) {
            const error = await getAudienceResponse.json();
            throw new Error(`Failed to get audience: ${error.error || JSON.stringify(error)}`);
        }

        const storedAudience = await getAudienceResponse.json();
        
        console.log('✅ Audience data retrieved!');
        console.log('   Offer ID:', storedAudience.offerId);
        console.log('   Offer Name:', storedAudience.offerName);
        console.log('   Count:', storedAudience.count);
        console.log('');

        if (storedAudience.audience && storedAudience.audience.length > 0) {
            console.log('   Stored audience members (first 5):');
            storedAudience.audience.slice(0, 5).forEach((member, index) => {
                console.log(`   ${index + 1}. ID: ${member.id}, ClientID: ${member.clientId}, Phone: ${member.phone}`);
                console.log(`      Matched At: ${member.matchedAt}`);
            });
            if (storedAudience.audience.length > 5) {
                console.log(`   ... and ${storedAudience.audience.length - 5} more`);
            }
            console.log('');
        }

        // Step 5: Validate the data
        console.log('5️⃣  Validating data...');
        console.log('');

        const validations = [];
        
        // Check if audience count matches
        if (audienceResult.audienceCount === storedAudience.count) {
            validations.push({ check: 'Audience count matches', status: '✅' });
        } else {
            validations.push({ 
                check: 'Audience count matches', 
                status: '❌', 
                details: `Expected ${audienceResult.audienceCount}, got ${storedAudience.count}` 
            });
        }

        // Check if all members have ClientID
        const allHaveClientId = storedAudience.audience.every(m => m.clientId);
        if (allHaveClientId) {
            validations.push({ check: 'All members have ClientID', status: '✅' });
        } else {
            validations.push({ check: 'All members have ClientID', status: '❌' });
        }

        // Check if all members have phone
        const allHavePhone = storedAudience.audience.every(m => m.phone);
        if (allHavePhone) {
            validations.push({ check: 'All members have phone numbers', status: '✅' });
        } else {
            validations.push({ check: 'All members have phone numbers', status: '❌' });
        }

        // Display validation results
        validations.forEach(v => {
            console.log(`   ${v.status} ${v.check}`);
            if (v.details) {
                console.log(`      ${v.details}`);
            }
        });
        console.log('');

        // Summary
        const allPassed = validations.every(v => v.status === '✅');
        
        console.log('==========================================');
        if (allPassed) {
            console.log('✅ ALL CHECKS PASSED!');
            console.log('✅ Phase 2 is confirmed working correctly!');
        } else {
            console.log('⚠️  SOME CHECKS FAILED');
            console.log('   Please review the validation results above');
        }
        console.log('==========================================');
        console.log('');

        // Display SQL query for manual verification
        console.log('📝 To verify in SQL Server, run:');
        console.log(`   SELECT * FROM OfferAudience WHERE offerId = '${offerId}';`);
        console.log('');
        console.log('📝 To verify clients match filters, check:');
        console.log('   - Age between 18-40 (calculated from BirthDate)');
        console.log('   - CameFrom = "ميامي"');
        console.log('   - Has at least 1 visit (minVisits: 1)');
        console.log('   - Total spend >= 0 (minSpend: 0)');
        console.log('');

        return {
            success: allPassed,
            offerId,
            audienceCount: audienceResult.audienceCount,
            validations
        };

    } catch (error) {
        console.error('\n❌ Test failed:', error.message);
        console.error('   Stack:', error.stack);
        
        // Cleanup on error
        if (ruleId && offerId) {
            try {
                await fetch(`${API_BASE}/${offerId}/targeting/${ruleId}`, { method: 'DELETE' });
            } catch (e) {
                console.error('   (Could not cleanup targeting rule)');
            }
        }
        if (offerId) {
            try {
                await fetch(`${API_BASE}/${offerId}`, { method: 'DELETE' });
            } catch (e) {
                console.error('   (Could not cleanup offer)');
            }
        }
        
        process.exit(1);
    }
}

// Check if server is running
console.log('🔍 Checking if server is running...\n');

fetch('http://localhost:3000/api/health')
    .then(response => {
        if (response.ok) {
            console.log('✅ Server is running!\n');
            return testAudienceBuildingFlow();
        } else {
            throw new Error('Server health check failed');
        }
    })
    .then(result => {
        if (result && result.success) {
            console.log('🎉 Test completed successfully!');
            process.exit(0);
        } else {
            console.log('⚠️  Test completed with warnings');
            process.exit(1);
        }
    })
    .catch(error => {
        console.error('❌ Server is not running!');
        console.error('   Please start the server first: node server.js');
        console.error('   Or use: start-server.bat');
        console.error('');
        console.error('   Error:', error.message);
        process.exit(1);
    });



