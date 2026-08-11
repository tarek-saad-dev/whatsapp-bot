/**
 * Test Script: Create Offer with Targeting for Recent Visits
 * 
 * Creates a test offer with targeting rules that match clients who visited recently
 * (e.g., yesterday or in the last 7 days)
 * 
 * Run: node test-audience-with-recent-visits.js
 */

const API_BASE = 'http://localhost:3000/api';

// Check if fetch is available (Node.js 18+)
if (typeof fetch === 'undefined') {
    console.error('❌ This script requires Node.js 18+ or install node-fetch');
    process.exit(1);
}

async function createTestOfferWithRecentVisits() {
    console.log('🧪 Creating Test Offer with Recent Visit Targeting');
    console.log('==========================================\n');

    try {
        // Step 1: Create offer
        console.log('1️⃣  Creating offer...');
        const offerData = {
            name: 'Test Offer - Recent Visitors',
            description: 'Special offer for recent visitors',
            minAge: null,
            maxAge: null,
            formUrl: null,
            status: 'draft'
        };

        const offerResponse = await fetch(`${API_BASE}/offers`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(offerData)
        });

        if (!offerResponse.ok) {
            const error = await offerResponse.json();
            throw new Error(`Failed to create offer: ${error.error || JSON.stringify(error)}`);
        }

        const offer = await offerResponse.json();
        const offerId = offer.id;
        console.log(`✅ Offer created: ${offerId}`);
        console.log(`   Name: ${offer.name}\n`);

        // Step 2: Add targeting rules for recent visits
        console.log('2️⃣  Adding targeting rules for recent visits...');
        
        // Calculate dates: last 7 days
        const today = new Date();
        const sevenDaysAgo = new Date(today);
        sevenDaysAgo.setDate(today.getDate() - 7);
        
        const lastVisitFrom = sevenDaysAgo.toISOString().split('T')[0]; // YYYY-MM-DD
        const lastVisitTo = today.toISOString().split('T')[0];
        
        const targetingData = {
            gender: null,
            city: null,
            maritalStatus: null,
            cameFrom: null, // No restriction on cameFrom
            lastVisitFrom: lastVisitFrom,
            lastVisitTo: lastVisitTo,
            minVisits: 1, // At least 1 visit
            minSpend: 0 // No minimum spend
        };

        const targetingResponse = await fetch(`${API_BASE}/offers/${offerId}/targeting`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(targetingData)
        });

        if (!targetingResponse.ok) {
            const error = await targetingResponse.json();
            throw new Error(`Failed to add targeting rules: ${error.error || JSON.stringify(error)}`);
        }

        const targeting = await targetingResponse.json();
        console.log(`✅ Targeting rules added`);
        console.log(`   Last Visit Range: ${lastVisitFrom} to ${lastVisitTo}`);
        console.log(`   Min Visits: ${targeting.minVisits}`);
        console.log(`   Min Spend: ${targeting.minSpend}\n`);

        // Step 3: Build audience
        console.log('3️⃣  Building audience...');
        const buildResponse = await fetch(`${API_BASE}/offers/${offerId}/build-audience`, {
            method: 'POST'
        });

        if (!buildResponse.ok) {
            const error = await buildResponse.json();
            throw new Error(`Failed to build audience: ${error.error || JSON.stringify(error)}`);
        }

        const buildResult = await buildResponse.json();
        console.log(`✅ Audience built: ${buildResult.audienceCount} members`);
        console.log(`   Message: ${buildResult.message}\n`);

        // Step 4: Get audience details
        if (buildResult.audienceCount > 0) {
            console.log('4️⃣  Getting audience preview...');
            const audienceResponse = await fetch(`${API_BASE}/offers/${offerId}/audience`);
            
            if (audienceResponse.ok) {
                const audienceData = await audienceResponse.json();
                console.log(`   Total: ${audienceData.count} members`);
                
                if (audienceData.audience && audienceData.audience.length > 0) {
                    console.log('   Sample (first 5):');
                    audienceData.audience.slice(0, 5).forEach((member, i) => {
                        console.log(`     ${i + 1}. ClientID: ${member.clientId}, Phone: ${member.phone}`);
                    });
                }
            }
            console.log('');
        }

        // Summary
        console.log('==========================================');
        console.log('SUMMARY');
        console.log('==========================================\n');
        console.log(`✅ Offer ID: ${offerId}`);
        console.log(`✅ Offer Name: ${offer.name}`);
        console.log(`✅ Audience Count: ${buildResult.audienceCount}`);
        console.log(`✅ Targeting: Recent visits (${lastVisitFrom} to ${lastVisitTo})`);
        console.log('');
        console.log('Next steps:');
        console.log(`   1. Create campaign: POST /api/campaigns with {"offerId": "${offerId}"}`);
        console.log(`   2. Start campaign: POST /api/campaigns/offers/{campaignId}/start`);
        console.log(`   3. Or run: node test-campaign-execution.js ${offerId}`);
        console.log('');

        return { offerId, audienceCount: buildResult.audienceCount };

    } catch (error) {
        console.error('\n❌ Test failed:', error.message);
        if (error.stack) {
            console.error('   Stack:', error.stack.split('\n').slice(0, 3).join('\n'));
        }
        process.exit(1);
    }
}

// Check if server is running
console.log('🔍 Checking if server is running...\n');

fetch(`${API_BASE}/health`)
    .then(response => {
        if (response.ok) {
            console.log('✅ Server is running!\n');
            return createTestOfferWithRecentVisits();
        } else {
            throw new Error('Server health check failed');
        }
    })
    .then(result => {
        if (result && result.audienceCount > 0) {
            console.log('🎉 Test completed successfully!');
            console.log(`✅ Offer ${result.offerId} has ${result.audienceCount} audience members`);
            process.exit(0);
        } else {
            console.log('⚠️  Test completed but audience count is 0');
            console.log('   This may be normal if no clients match the criteria in your database');
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



