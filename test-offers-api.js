/**
 * Test script for Offers API
 * Run: node test-offers-api.js
 */

const API_BASE = 'http://localhost:3000/api/offers';

// Check if fetch is available (Node.js 18+)
if (typeof fetch === 'undefined') {
    console.error('❌ This script requires Node.js 18+ or install node-fetch');
    console.error('   Run: npm install node-fetch');
    process.exit(1);
}

async function testOffersAPI() {
    console.log('🧪 Testing Offers API');
    console.log('=====================================\n');

    let offerId = null;
    let ruleId = null;

    try {
        // Test 1: Create an offer
        console.log('1️⃣  Creating a new offer...');
        const createOfferResponse = await fetch(API_BASE, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: 'Winter Offer',
                description: '50% discount for 1 week',
                minAge: 18,
                maxAge: 35,
                formUrl: 'https://forms.google.com/myform',
                status: 'draft'
            })
        });

        if (!createOfferResponse.ok) {
            const error = await createOfferResponse.json();
            throw new Error(`Failed to create offer: ${error.error}`);
        }

        const newOffer = await createOfferResponse.json();
        offerId = newOffer.id;
        console.log('✅ Offer created:', newOffer.id);
        console.log('   Name:', newOffer.name);
        console.log('   Status:', newOffer.status);
        console.log('');

        // Test 2: Get all offers
        console.log('2️⃣  Getting all offers...');
        const getAllResponse = await fetch(API_BASE);
        const allOffers = await getAllResponse.json();
        console.log(`✅ Found ${allOffers.length} offer(s)`);
        console.log('');

        // Test 3: Get specific offer
        console.log('3️⃣  Getting specific offer...');
        const getOfferResponse = await fetch(`${API_BASE}/${offerId}`);
        const offer = await getOfferResponse.json();
        console.log('✅ Offer retrieved:', offer.name);
        console.log('   Targeting rules:', offer.targetingRules?.length || 0);
        console.log('');

        // Test 4: Create targeting rules
        console.log('4️⃣  Creating targeting rules...');
        const createRuleResponse = await fetch(`${API_BASE}/${offerId}/targeting`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                gender: 'female',
                city: 'Cairo',
                maritalStatus: 'single',
                cameFrom: 'instagram',
                lastVisitFrom: '2024-01-01',
                lastVisitTo: '2024-01-15',
                minVisits: 3,
                minSpend: 500.00
            })
        });

        if (!createRuleResponse.ok) {
            const error = await createRuleResponse.json();
            throw new Error(`Failed to create targeting rule: ${error.error}`);
        }

        const newRule = await createRuleResponse.json();
        ruleId = newRule.id;
        console.log('✅ Targeting rule created:', ruleId);
        console.log('   City:', newRule.city);
        console.log('   Min Spend:', newRule.minSpend);
        console.log('');

        // Test 5: Get targeting rules
        console.log('5️⃣  Getting targeting rules for offer...');
        const getRulesResponse = await fetch(`${API_BASE}/${offerId}/targeting`);
        const rules = await getRulesResponse.json();
        console.log(`✅ Found ${rules.length} targeting rule(s)`);
        console.log('');

        // Test 6: Update offer
        console.log('6️⃣  Updating offer...');
        const updateOfferResponse = await fetch(`${API_BASE}/${offerId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                status: 'active',
                description: 'Updated description'
            })
        });

        const updatedOffer = await updateOfferResponse.json();
        console.log('✅ Offer updated');
        console.log('   New status:', updatedOffer.status);
        console.log('');

        // Test 7: Update targeting rule
        if (ruleId) {
            console.log('7️⃣  Updating targeting rule...');
            const updateRuleResponse = await fetch(`${API_BASE}/${offerId}/targeting/${ruleId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    city: 'Alexandria',
                    minSpend: 750.00
                })
            });

            const updatedRule = await updateRuleResponse.json();
            console.log('✅ Targeting rule updated');
            console.log('   New city:', updatedRule.city);
            console.log('   New min spend:', updatedRule.minSpend);
            console.log('');
        }

        // Test 8: Cleanup - Delete targeting rule
        if (ruleId) {
            console.log('8️⃣  Deleting targeting rule...');
            const deleteRuleResponse = await fetch(`${API_BASE}/${offerId}/targeting/${ruleId}`, {
                method: 'DELETE'
            });
            console.log('✅ Targeting rule deleted');
            console.log('');
        }

        // Test 9: Cleanup - Delete offer
        if (offerId) {
            console.log('9️⃣  Deleting offer...');
            const deleteOfferResponse = await fetch(`${API_BASE}/${offerId}`, {
                method: 'DELETE'
            });
            console.log('✅ Offer deleted');
            console.log('');
        }

        console.log('=====================================');
        console.log('✅ All tests passed!');
        console.log('=====================================');

    } catch (error) {
        console.error('\n❌ Test failed:', error.message);
        
        // Cleanup on error
        if (ruleId && offerId) {
            try {
                await fetch(`${API_BASE}/${offerId}/targeting/${ruleId}`, { method: 'DELETE' });
            } catch (e) {}
        }
        if (offerId) {
            try {
                await fetch(`${API_BASE}/${offerId}`, { method: 'DELETE' });
            } catch (e) {}
        }
        
        process.exit(1);
    }
}

// Check if server is running
fetch('http://localhost:3000/api/health')
    .then(() => {
        testOffersAPI();
    })
    .catch(() => {
        console.error('❌ Server is not running!');
        console.error('   Please start the server first: node server.js');
        process.exit(1);
    });



