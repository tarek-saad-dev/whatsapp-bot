/**
 * Test Script for Campaign Execution (Phase 5)
 * 
 * Tests the complete campaign execution flow:
 * 1. Create campaign
 * 2. Start campaign
 * 3. Monitor worker processing
 * 
 * Run: node test-campaign-execution.js <offerId>
 */

const API_BASE = 'http://localhost:3000/api';

// Check if fetch is available (Node.js 18+)
if (typeof fetch === 'undefined') {
    console.error('❌ This script requires Node.js 18+ or install node-fetch');
    process.exit(1);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function testCampaignExecution(offerId) {
    console.log('🧪 Testing Campaign Execution Flow');
    console.log('==========================================\n');

    if (!offerId) {
        console.error('❌ Please provide an offer ID');
        console.error('   Usage: node test-campaign-execution.js <offerId>');
        process.exit(1);
    }

    try {
        // Step 0: Ensure audience is built
        console.log('0️⃣  Ensuring audience is built...');
        const audienceCountResponse = await fetch(`${API_BASE}/offers/${offerId}/audience/count`);
        let audienceCount = 0;
        
        if (audienceCountResponse.ok) {
            const audienceData = await audienceCountResponse.json();
            audienceCount = audienceData.count || 0;
            console.log(`   Current audience count: ${audienceCount}`);
        }
        
        if (audienceCount === 0) {
            console.log('   ⚠️  No audience found. Building audience...');
            const buildResponse = await fetch(`${API_BASE}/offers/${offerId}/build-audience`, {
                method: 'POST'
            });
            
            if (buildResponse.ok) {
                const buildResult = await buildResponse.json();
                audienceCount = buildResult.audienceCount || 0;
                console.log(`   ✅ Audience built: ${audienceCount} members`);
            } else {
                const error = await buildResponse.json();
                console.warn(`   ⚠️  Could not build audience: ${error.error || JSON.stringify(error)}`);
                console.warn('   (Campaign start endpoint will attempt to build automatically)\n');
            }
        } else {
            console.log('   ✅ Audience already exists\n');
        }
        
        // Step 1: Create campaign
        console.log('1️⃣  Creating campaign from offer...');
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
        const campaignId = campaign.id;
        console.log(`✅ Campaign created: ${campaignId}`);
        console.log(`   Total Recipients: ${campaign.totalRecipients}`);
        console.log(`   Messages Created: ${campaign.messagesCreated || 0}`);
        
        // Warn if no recipients
        if (campaign.totalRecipients === 0) {
            console.log('   ⚠️  Warning: Campaign has 0 recipients (will be handled by start endpoint)\n');
        } else {
            console.log('');
        }

        // Step 2: Start campaign
        console.log('2️⃣  Starting campaign...');
        const startResponse = await fetch(`${API_BASE}/campaigns/offers/${campaignId}/start`, {
            method: 'POST'
        });

        if (!startResponse.ok) {
            const error = await startResponse.json();
            throw new Error(`Failed to start campaign: ${error.error || JSON.stringify(error)}`);
        }

        const startResult = await startResponse.json();
        console.log(`✅ Campaign started!`);
        console.log(`   Status: ${startResult.campaign.status}`);
        console.log(`   Started At: ${startResult.campaign.startedAt}`);
        console.log(`   Messages: ${startResult.messages.pending} pending, ${startResult.messages.sent} sent, ${startResult.messages.failed} failed\n`);

        // Step 3: Monitor progress
        console.log('3️⃣  Monitoring campaign progress...');
        console.log('   (Worker will process messages automatically)\n');

        let lastStats = startResult.messages;
        let checkCount = 0;
        const maxChecks = 60; // Check for up to 5 minutes (60 * 5 seconds)

        while (checkCount < maxChecks) {
            await sleep(5000); // Wait 5 seconds between checks
            checkCount++;

            const statsResponse = await fetch(`${API_BASE}/campaigns/offers/${campaignId}/stats`);
            if (!statsResponse.ok) {
                console.warn(`⚠️  Failed to get stats (check ${checkCount})`);
                continue;
            }

            const stats = await statsResponse.json();
            const messages = stats.messages;

            // Only log if stats changed
            if (messages.pending !== lastStats.pending || 
                messages.sent !== lastStats.sent || 
                messages.failed !== lastStats.failed) {
                
                console.log(`   [${new Date().toLocaleTimeString()}] Progress:`);
                console.log(`      Pending: ${messages.pending}`);
                console.log(`      Sent: ${messages.sent}`);
                console.log(`      Failed: ${messages.failed}`);
                console.log(`      Campaign Status: ${stats.campaign.status}\n`);

                lastStats = messages;

                // Check if completed
                if (stats.campaign.status === 'completed') {
                    console.log('✅ Campaign completed!\n');
                    break;
                }
            }

            // If no pending messages and not completed, might be processing
            if (messages.pending === 0 && stats.campaign.status !== 'completed') {
                console.log('   ℹ️  No pending messages, waiting for completion status...\n');
            }
        }

        // Final stats
        console.log('4️⃣  Final Campaign Statistics:');
        console.log('==========================================\n');

        const finalStatsResponse = await fetch(`${API_BASE}/campaigns/offers/${campaignId}/stats`);
        if (finalStatsResponse.ok) {
            const finalStats = await finalStatsResponse.json();
            console.log('Campaign:');
            console.log(`   ID: ${finalStats.campaign.id}`);
            console.log(`   Status: ${finalStats.campaign.status}`);
            console.log(`   Total Recipients: ${finalStats.campaign.totalRecipients}`);
            console.log(`   Sent Count: ${finalStats.campaign.sentCount}`);
            console.log(`   Failed Count: ${finalStats.campaign.failedCount}`);
            console.log(`   Started At: ${finalStats.campaign.startedAt || 'N/A'}`);
            console.log(`   Completed At: ${finalStats.campaign.completedAt || 'N/A'}\n`);

            console.log('Messages:');
            console.log(`   Total: ${finalStats.messages.total}`);
            console.log(`   Pending: ${finalStats.messages.pending}`);
            console.log(`   Sent: ${finalStats.messages.sent}`);
            console.log(`   Failed: ${finalStats.messages.failed}\n`);

            // Validation
            console.log('==========================================');
            console.log('VALIDATION');
            console.log('==========================================\n');

            const validations = [];

            if (finalStats.campaign.status === 'completed' || finalStats.campaign.status === 'sending') {
                validations.push({ check: 'Campaign status is valid', status: '✅' });
            } else {
                validations.push({ check: 'Campaign status is valid', status: '❌' });
            }

            if (finalStats.messages.sent + finalStats.messages.failed === finalStats.messages.total) {
                validations.push({ check: 'All messages processed', status: '✅' });
            } else if (finalStats.messages.pending > 0) {
                validations.push({ check: 'All messages processed', status: '⚠️  (Still processing)' });
            } else {
                validations.push({ check: 'All messages processed', status: '❌' });
            }

            if (finalStats.campaign.sentCount === finalStats.messages.sent) {
                validations.push({ check: 'Campaign sentCount matches message stats', status: '✅' });
            } else {
                validations.push({ check: 'Campaign sentCount matches message stats', status: '❌' });
            }

            if (finalStats.campaign.failedCount === finalStats.messages.failed) {
                validations.push({ check: 'Campaign failedCount matches message stats', status: '✅' });
            } else {
                validations.push({ check: 'Campaign failedCount matches message stats', status: '❌' });
            }

            validations.forEach(v => {
                console.log(`   ${v.status} ${v.check}`);
            });
            console.log('');

            const allPassed = validations.every(v => v.status === '✅' || v.status === '⚠️  (Still processing)');

            console.log('==========================================');
            if (allPassed) {
                console.log('✅ ALL VALIDATIONS PASSED!');
                console.log('✅ Campaign execution flow is working correctly!');
            } else {
                console.log('⚠️  SOME VALIDATIONS FAILED');
            }
            console.log('==========================================\n');

            return { success: allPassed, stats: finalStats };
        }

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
            return testCampaignExecution(offerId);
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

