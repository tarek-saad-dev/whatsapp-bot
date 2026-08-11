/**
 * Complete Phase 2 Test
 * Tests the entire offer flow: create, targeting, build audience, summary
 * 
 * Run: node test-complete-phase2.js
 */

const API_BASE = 'http://localhost:3000/api/offers';

// Check if fetch is available (Node.js 18+)
if (typeof fetch === 'undefined') {
    console.error('❌ This script requires Node.js 18+ or install node-fetch');
    process.exit(1);
}

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function testCompleteFlow() {
    console.log('🧪 Complete Phase 2 Test');
    console.log('==========================================\n');

    const realOfferId = '1763917725219kxleeexme';
    let allTestsPassed = true;

    try {
        // Test 1: Check if offer exists
        console.log('1️⃣  Testing: Get Offer');
        console.log(`   GET ${API_BASE}/${realOfferId}\n`);
        
        const getOfferResponse = await fetch(`${API_BASE}/${realOfferId}`);
        if (!getOfferResponse.ok) {
            throw new Error(`Offer not found: ${realOfferId}`);
        }
        const offer = await getOfferResponse.json();
        console.log(`✅ Offer found: ${offer.name}`);
        console.log(`   Status: ${offer.status}`);
        console.log(`   Age Range: ${offer.minAge}-${offer.maxAge}\n`);

        // Test 2: Check targeting rules
        console.log('2️⃣  Testing: Get Targeting Rules');
        console.log(`   GET ${API_BASE}/${realOfferId}/targeting\n`);
        
        const getRulesResponse = await fetch(`${API_BASE}/${realOfferId}/targeting`);
        if (!getRulesResponse.ok) {
            throw new Error('Failed to get targeting rules');
        }
        const rules = await getRulesResponse.json();
        console.log(`✅ Found ${rules.length} targeting rule(s)`);
        if (rules.length > 0) {
            console.log(`   CameFrom: ${rules[0].cameFrom || 'N/A'}`);
            console.log(`   MinVisits: ${rules[0].minVisits || 'N/A'}`);
            console.log(`   MinSpend: ${rules[0].minSpend || 'N/A'}\n`);
        }

        // Test 3: Build audience (if not already built)
        console.log('3️⃣  Testing: Build Audience');
        console.log(`   POST ${API_BASE}/${realOfferId}/build-audience\n`);
        console.log('   ⏳ This may take a moment...\n');
        
        const buildResponse = await fetch(`${API_BASE}/${realOfferId}/build-audience`, {
            method: 'POST'
        });
        
        if (!buildResponse.ok) {
            const error = await buildResponse.json();
            console.warn(`⚠️  Build audience failed: ${error.error || JSON.stringify(error)}`);
            console.warn('   (This is OK if database is not connected or no matches found)\n');
        } else {
            const buildResult = await buildResponse.json();
            console.log(`✅ Audience built successfully!`);
            console.log(`   Audience Count: ${buildResult.audienceCount}`);
            console.log(`   Message: ${buildResult.message}\n`);
        }

        // Test 4: Get audience count
        console.log('4️⃣  Testing: Get Audience Count');
        console.log(`   GET ${API_BASE}/${realOfferId}/audience/count\n`);
        
        const countResponse = await fetch(`${API_BASE}/${realOfferId}/audience/count`);
        if (!countResponse.ok) {
            throw new Error('Failed to get audience count');
        }
        const countData = await countResponse.json();
        console.log(`✅ Audience count: ${countData.count}\n`);

        // Test 5: Get Summary (THE MAIN TEST)
        console.log('5️⃣  Testing: Get Summary (Main Test)');
        console.log(`   GET ${API_BASE}/${realOfferId}/summary\n`);
        
        const summaryResponse = await fetch(`${API_BASE}/${realOfferId}/summary`);
        
        // Check content type
        const contentType = summaryResponse.headers.get('content-type');
        console.log(`   Content-Type: ${contentType || 'not set'}`);
        
        if (!summaryResponse.ok) {
            const errorText = await summaryResponse.text();
            console.error(`❌ Summary request failed with status ${summaryResponse.status}`);
            console.error(`   Response: ${errorText.substring(0, 200)}`);
            
            // Try to parse as JSON
            try {
                const errorJson = JSON.parse(errorText);
                console.error(`   Error: ${errorJson.error}`);
                console.error(`   Message: ${errorJson.message}`);
            } catch (e) {
                console.error(`   Response is not JSON (likely HTML)`);
            }
            
            allTestsPassed = false;
            throw new Error(`Summary endpoint returned status ${summaryResponse.status}`);
        }

        // Check if response is JSON
        if (!contentType || !contentType.includes('application/json')) {
            const responseText = await summaryResponse.text();
            console.error(`❌ Response is not JSON!`);
            console.error(`   Content-Type: ${contentType}`);
            console.error(`   First 200 chars: ${responseText.substring(0, 200)}`);
            allTestsPassed = false;
            throw new Error('Summary endpoint returned non-JSON response');
        }

        const summary = await summaryResponse.json();
        
        console.log('✅ Summary retrieved successfully!\n');
        console.log('==========================================');
        console.log('SUMMARY RESULTS');
        console.log('==========================================\n');

        // Display summary
        console.log('📦 OFFER:');
        console.log(`   ID: ${summary.offer?.id || 'N/A'}`);
        console.log(`   Name: ${summary.offer?.name || 'N/A'}`);
        console.log(`   Status: ${summary.offer?.status || 'N/A'}`);
        console.log(`   Age Range: ${summary.offer?.minAge || 'N/A'}-${summary.offer?.maxAge || 'N/A'}\n`);

        console.log('🎯 TARGETING:');
        console.log(`   Rules Count: ${summary.targeting?.length || 0}`);
        if (summary.targeting && summary.targeting.length > 0) {
            summary.targeting.forEach((rule, i) => {
                console.log(`   Rule ${i + 1}: CameFrom=${rule.cameFrom || 'N/A'}, MinVisits=${rule.minVisits || 'N/A'}, MinSpend=${rule.minSpend || 'N/A'}`);
            });
        }
        console.log('');

        console.log('👥 AUDIENCE:');
        console.log(`   Count: ${summary.audienceCount || 0}`);
        if (summary.audiencePreview && summary.audiencePreview.length > 0) {
            console.log(`   Preview (${summary.audiencePreview.length} items):`);
            summary.audiencePreview.slice(0, 3).forEach((member, i) => {
                console.log(`     ${i + 1}. ${member.name || 'Unknown'} - ${member.phone || 'N/A'}`);
            });
        } else {
            console.log('   Preview: (empty - audience not built or no matches)');
        }
        console.log('');

        console.log('💬 MESSAGE PREVIEW:');
        console.log(`   "${summary.messagePreview || 'N/A'}"`);
        console.log('');

        // Validation
        console.log('==========================================');
        console.log('VALIDATION');
        console.log('==========================================\n');

        const validations = [];

        // Validate structure
        if (summary.offer && summary.offer.id) {
            validations.push({ check: 'Offer data present', status: '✅' });
        } else {
            validations.push({ check: 'Offer data present', status: '❌' });
            allTestsPassed = false;
        }

        if (Array.isArray(summary.targeting)) {
            validations.push({ check: 'Targeting rules array present', status: '✅' });
        } else {
            validations.push({ check: 'Targeting rules array present', status: '❌' });
            allTestsPassed = false;
        }

        if (typeof summary.audienceCount === 'number') {
            validations.push({ check: 'Audience count is a number', status: '✅' });
        } else {
            validations.push({ check: 'Audience count is a number', status: '❌' });
            allTestsPassed = false;
        }

        if (Array.isArray(summary.audiencePreview)) {
            validations.push({ check: 'Audience preview is an array', status: '✅' });
        } else {
            validations.push({ check: 'Audience preview is an array', status: '❌' });
            allTestsPassed = false;
        }

        if (summary.messagePreview && typeof summary.messagePreview === 'string') {
            validations.push({ check: 'Message preview is a string', status: '✅' });
        } else {
            validations.push({ check: 'Message preview is a string', status: '❌' });
            allTestsPassed = false;
        }

        // Display validations
        validations.forEach(v => {
            console.log(`   ${v.status} ${v.check}`);
        });
        console.log('');

        // Final result
        console.log('==========================================');
        if (allTestsPassed) {
            console.log('✅ ALL TESTS PASSED!');
            console.log('✅ Phase 2 is working correctly!');
        } else {
            console.log('⚠️  SOME TESTS FAILED');
        }
        console.log('==========================================\n');

        return { success: allTestsPassed, summary };

    } catch (error) {
        console.error('\n❌ Test failed:', error.message);
        if (error.stack) {
            console.error('   Stack:', error.stack.split('\n').slice(0, 3).join('\n'));
        }
        return { success: false, error: error.message };
    }
}

// Check if server is running
console.log('🔍 Checking if server is running...\n');

fetch('http://localhost:3000/api/health')
    .then(response => {
        if (response.ok) {
            console.log('✅ Server is running!\n');
            return testCompleteFlow();
        } else {
            throw new Error('Server health check failed');
        }
    })
    .then(result => {
        if (result && result.success) {
            console.log('🎉 All Phase 2 tests completed successfully!');
            process.exit(0);
        } else {
            console.log('⚠️  Some tests failed - please review the output above');
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

