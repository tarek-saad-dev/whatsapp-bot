/**
 * Test Script for Creating Offer-Based Campaign
 * 
 * Tests: POST /api/campaigns with offerId
 * 
 * Run: node test-create-campaign.js <offerId>
 */

const API_BASE = 'http://localhost:3000/api';

// Check if fetch is available (Node.js 18+)
if (typeof fetch === 'undefined') {
    console.error('❌ This script requires Node.js 18+ or install node-fetch');
    process.exit(1);
}

async function testCreateCampaign(offerId) {
    console.log('🧪 Testing Campaign Creation from Offer');
    console.log('==========================================\n');

    if (!offerId) {
        console.error('❌ Please provide an offer ID');
        console.error('   Usage: node test-create-campaign.js <offerId>');
        console.error('');
        console.error('   Example: node test-create-campaign.js 1763917725219kxleeexme');
        process.exit(1);
    }

    try {
        console.log(`📋 Testing campaign creation for offer: ${offerId}\n`);

        // Step 1: Check if offer exists
        console.log('1️⃣  Checking if offer exists...');
        const offerResponse = await fetch(`${API_BASE}/offers/${offerId}`);
        
        if (!offerResponse.ok) {
            throw new Error(`Offer not found: ${offerId}`);
        }
        
        const offer = await offerResponse.json();
        console.log(`✅ Offer found: ${offer.name}`);
        console.log(`   Status: ${offer.status}\n`);

        // Step 2: Check if audience is built
        console.log('2️⃣  Checking audience...');
        const audienceResponse = await fetch(`${API_BASE}/offers/${offerId}/audience/count`);
        const audienceData = await audienceResponse.json();
        console.log(`   Audience count: ${audienceData.count}`);
        
        if (audienceData.count === 0) {
            console.log('   ⚠️  No audience found. Building audience first...\n');
            
            const buildResponse = await fetch(`${API_BASE}/offers/${offerId}/build-audience`, {
                method: 'POST'
            });
            
            if (!buildResponse.ok) {
                const error = await buildResponse.json();
                console.warn(`   ⚠️  Could not build audience: ${error.error || JSON.stringify(error)}`);
                console.warn('   (Campaign can still be created with 0 recipients, and start endpoint will auto-build)\n');
            } else {
                const buildResult = await buildResponse.json();
                console.log(`   ✅ Audience built: ${buildResult.audienceCount} members`);
                if (buildResult.audienceCount === 0) {
                    console.log('   ℹ️  Note: No clients matched targeting criteria.');
                    console.log('   ℹ️  Campaign can still be created with 0 recipients for testing.');
                    console.log('   ℹ️  Start endpoint will attempt to auto-build audience.\n');
                } else {
                    console.log('');
                }
            }
        } else {
            console.log('   ✅ Audience already exists\n');
        }

        // Step 3: Create campaign
        console.log('3️⃣  Creating campaign from offer...');
        console.log(`   POST ${API_BASE}/campaigns`);
        console.log(`   Body: { "offerId": "${offerId}" }\n`);

        const createResponse = await fetch(`${API_BASE}/campaigns`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ offerId })
        });

        if (!createResponse.ok) {
            const error = await createResponse.json();
            throw new Error(`Failed to create campaign: ${error.error || JSON.stringify(error)}`);
        }

        const campaign = await createResponse.json();
        
        console.log('✅ Campaign created successfully!\n');
        console.log('==========================================');
        console.log('CAMPAIGN DETAILS');
        console.log('==========================================\n');
        console.log(`   ID: ${campaign.id}`);
        console.log(`   Offer ID: ${campaign.offerId}`);
        console.log(`   Status: ${campaign.status}`);
        console.log(`   Total Recipients: ${campaign.totalRecipients}`);
        console.log(`   Sent Count: ${campaign.sentCount}`);
        console.log(`   Failed Count: ${campaign.failedCount}`);
        console.log(`   Messages Created: ${campaign.messagesCreated || 0}`);
        console.log(`   Created At: ${campaign.createdAt}`);
        console.log('');

        // Step 4: Get campaign messages
        console.log('4️⃣  Checking campaign messages...');
        const messagesResponse = await fetch(`${API_BASE}/campaigns/offers/${campaign.id}/messages`);
        
        if (messagesResponse.ok) {
            const messagesData = await messagesResponse.json();
            console.log(`   Total Messages: ${messagesData.count}`);
            
            if (messagesData.messages && messagesData.messages.length > 0) {
                console.log('   Sample messages (first 3):');
                messagesData.messages.slice(0, 3).forEach((msg, i) => {
                    console.log(`     ${i + 1}. ClientID: ${msg.clientId}, Phone: ${msg.phone}, Status: ${msg.status}`);
                });
            }
        }
        console.log('');

        // Step 5: Get campaign stats
        console.log('5️⃣  Getting campaign statistics...');
        const statsResponse = await fetch(`${API_BASE}/campaigns/offers/${campaign.id}/stats`);
        
        if (statsResponse.ok) {
            const stats = await statsResponse.json();
            console.log('   Campaign Stats:');
            console.log(`     Total Recipients: ${stats.campaign.totalRecipients}`);
            console.log(`     Sent: ${stats.campaign.sentCount}`);
            console.log(`     Failed: ${stats.campaign.failedCount}`);
            console.log('   Message Stats:');
            console.log(`     Total: ${stats.messages.total}`);
            console.log(`     Pending: ${stats.messages.pending}`);
            console.log(`     Sent: ${stats.messages.sent}`);
            console.log(`     Failed: ${stats.messages.failed}`);
        }
        console.log('');

        // Validation
        console.log('==========================================');
        console.log('VALIDATION');
        console.log('==========================================\n');

        const validations = [];

        if (campaign.id) {
            validations.push({ check: 'Campaign ID generated', status: '✅' });
        } else {
            validations.push({ check: 'Campaign ID generated', status: '❌' });
        }

        if (campaign.offerId === offerId) {
            validations.push({ check: 'Campaign linked to correct offer', status: '✅' });
        } else {
            validations.push({ check: 'Campaign linked to correct offer', status: '❌' });
        }

        if (campaign.status === 'draft') {
            validations.push({ check: 'Campaign status is draft', status: '✅' });
        } else {
            validations.push({ check: 'Campaign status is draft', status: '❌' });
        }

        if (typeof campaign.totalRecipients === 'number' && campaign.totalRecipients >= 0) {
            validations.push({ check: 'Total recipients calculated', status: '✅' });
        } else {
            validations.push({ check: 'Total recipients calculated', status: '❌' });
        }

        if (campaign.messagesCreated && campaign.messagesCreated > 0) {
            validations.push({ check: 'Campaign messages created', status: '✅' });
        } else if (campaign.totalRecipients === 0) {
            validations.push({ check: 'Campaign messages created', status: '⚠️  (No recipients - OK for testing)' });
        } else {
            validations.push({ check: 'Campaign messages created', status: '❌' });
        }
        
        // Check for warning message
        if (campaign.warning) {
            validations.push({ check: 'Warning message provided', status: '✅' });
            console.log(`   ℹ️  Warning: ${campaign.warning}`);
        }

        validations.forEach(v => {
            console.log(`   ${v.status} ${v.check}`);
        });
        console.log('');

        const allPassed = validations.every(v => v.status === '✅' || v.status === '⚠️  (No recipients)');

        console.log('==========================================');
        if (allPassed) {
            console.log('✅ ALL VALIDATIONS PASSED!');
            console.log('✅ Campaign creation is working correctly!');
        } else {
            console.log('⚠️  SOME VALIDATIONS FAILED');
        }
        console.log('==========================================\n');

        return {
            success: allPassed,
            campaign
        };

    } catch (error) {
        console.error('\n❌ Test failed:', error.message);
        if (error.stack) {
            console.error('   Stack:', error.stack.split('\n').slice(0, 3).join('\n'));
        }
        process.exit(1);
    }
}

// Get offerId from command line
const offerId = process.argv[2];

// Check if server is running
console.log('🔍 Checking if server is running...\n');

fetch(`${API_BASE}/health`)
    .then(response => {
        if (response.ok) {
            console.log('✅ Server is running!\n');
            return testCreateCampaign(offerId);
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

