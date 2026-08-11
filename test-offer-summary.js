/**
 * Test Script for Offer Summary Endpoint
 * 
 * Tests: GET /api/offers/:id/summary
 * 
 * Run: node test-offer-summary.js <offerId>
 */

const API_BASE = 'http://localhost:3000/api/offers';

// Check if fetch is available (Node.js 18+)
if (typeof fetch === 'undefined') {
    console.error('❌ This script requires Node.js 18+ or install node-fetch');
    console.error('   Run: npm install node-fetch');
    process.exit(1);
}

async function testOfferSummary(offerId) {
    console.log('🧪 Testing Offer Summary Endpoint');
    console.log('=====================================\n');

    if (!offerId) {
        console.error('❌ Please provide an offer ID');
        console.error('   Usage: node test-offer-summary.js <offerId>');
        console.error('');
        console.error('   Example: node test-offer-summary.js 1234567890abcdef');
        process.exit(1);
    }

    try {
        console.log(`📋 Testing summary for offer: ${offerId}\n`);

        // Test summary endpoint
        console.log('1️⃣  Getting offer summary...');
        console.log(`   GET ${API_BASE}/${offerId}/summary\n`);

        const response = await fetch(`${API_BASE}/${offerId}/summary`);

        if (!response.ok) {
            const error = await response.json();
            if (response.status === 404) {
                console.error('❌ Offer not found');
                console.error('   Error:', error.error);
                console.error('   Message:', error.message);
                process.exit(1);
            } else {
                throw new Error(`Failed to get summary: ${error.error || JSON.stringify(error)}`);
            }
        }

        const summary = await response.json();

        console.log('✅ Summary retrieved successfully!\n');
        console.log('=====================================');
        console.log('SUMMARY RESULTS');
        console.log('=====================================\n');

        // Display offer info
        console.log('📦 OFFER:');
        console.log(`   ID: ${summary.offer.id}`);
        console.log(`   Name: ${summary.offer.name}`);
        console.log(`   Description: ${summary.offer.description || '(none)'}`);
        console.log(`   Status: ${summary.offer.status}`);
        console.log(`   Age Range: ${summary.offer.minAge || 'N/A'} - ${summary.offer.maxAge || 'N/A'}`);
        console.log(`   Form URL: ${summary.offer.formUrl || '(none)'}`);
        console.log(`   Created: ${summary.offer.createdAt}`);
        console.log('');

        // Display targeting rules
        console.log('🎯 TARGETING RULES:');
        if (summary.targeting && summary.targeting.length > 0) {
            summary.targeting.forEach((rule, index) => {
                console.log(`   Rule ${index + 1}:`);
                if (rule.gender) console.log(`      Gender: ${rule.gender}`);
                if (rule.city) console.log(`      City: ${rule.city}`);
                if (rule.maritalStatus) console.log(`      Marital Status: ${rule.maritalStatus}`);
                if (rule.cameFrom) console.log(`      Came From: ${rule.cameFrom}`);
                if (rule.lastVisitFrom || rule.lastVisitTo) {
                    console.log(`      Last Visit: ${rule.lastVisitFrom || 'any'} to ${rule.lastVisitTo || 'any'}`);
                }
                if (rule.minVisits) console.log(`      Min Visits: ${rule.minVisits}`);
                if (rule.minSpend) console.log(`      Min Spend: ${rule.minSpend}`);
            });
        } else {
            console.log('   (No targeting rules defined)');
        }
        console.log('');

        // Display audience count
        console.log('👥 AUDIENCE:');
        console.log(`   Count: ${summary.audienceCount}`);
        console.log('');

        // Display audience preview
        if (summary.audiencePreview && summary.audiencePreview.length > 0) {
            console.log('   Preview (first 5):');
            summary.audiencePreview.forEach((member, index) => {
                console.log(`   ${index + 1}. ${member.name} - ${member.phone}`);
            });
        } else {
            console.log('   Preview: (No audience built yet)');
        }
        console.log('');

        // Display message preview
        console.log('💬 MESSAGE PREVIEW:');
        console.log(`   "${summary.messagePreview}"`);
        console.log('');

        // Validation
        console.log('=====================================');
        console.log('VALIDATION');
        console.log('=====================================\n');

        const validations = [];

        // Check offer data
        if (summary.offer && summary.offer.id) {
            validations.push({ check: 'Offer data present', status: '✅' });
        } else {
            validations.push({ check: 'Offer data present', status: '❌' });
        }

        // Check targeting rules
        if (Array.isArray(summary.targeting)) {
            validations.push({ check: 'Targeting rules array present', status: '✅' });
        } else {
            validations.push({ check: 'Targeting rules array present', status: '❌' });
        }

        // Check audience count
        if (typeof summary.audienceCount === 'number') {
            validations.push({ check: 'Audience count is a number', status: '✅' });
        } else {
            validations.push({ check: 'Audience count is a number', status: '❌' });
        }

        // Check audience preview
        if (Array.isArray(summary.audiencePreview)) {
            validations.push({ check: 'Audience preview is an array', status: '✅' });
            
            if (summary.audienceCount === 0 && summary.audiencePreview.length === 0) {
                validations.push({ check: 'Empty audience handled correctly', status: '✅' });
            } else if (summary.audienceCount > 0 && summary.audiencePreview.length > 0) {
                validations.push({ check: 'Audience preview has data when audience exists', status: '✅' });
            }
        } else {
            validations.push({ check: 'Audience preview is an array', status: '❌' });
        }

        // Check message preview
        if (summary.messagePreview && typeof summary.messagePreview === 'string') {
            validations.push({ check: 'Message preview is a string', status: '✅' });
        } else {
            validations.push({ check: 'Message preview is a string', status: '❌' });
        }

        // Display validation results
        validations.forEach(v => {
            console.log(`   ${v.status} ${v.check}`);
        });
        console.log('');

        // Summary
        const allPassed = validations.every(v => v.status === '✅');
        
        console.log('=====================================');
        if (allPassed) {
            console.log('✅ ALL VALIDATIONS PASSED!');
        } else {
            console.log('⚠️  SOME VALIDATIONS FAILED');
        }
        console.log('=====================================\n');

        return {
            success: allPassed,
            summary
        };

    } catch (error) {
        console.error('\n❌ Test failed:', error.message);
        console.error('   Stack:', error.stack);
        process.exit(1);
    }
}

// Get offerId from command line
const offerId = process.argv[2];

// Check if server is running
console.log('🔍 Checking if server is running...\n');

fetch('http://localhost:3000/api/health')
    .then(response => {
        if (response.ok) {
            console.log('✅ Server is running!\n');
            return testOfferSummary(offerId);
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

