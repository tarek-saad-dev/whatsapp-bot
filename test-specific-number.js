/**
 * Test the endpoint with a specific phone number
 */
require('dotenv').config();

const API_TOKEN = process.env.SQL_TRIGGER_TOKEN || 'your-secret-token-change-this';
const ENDPOINT = 'http://localhost:3000/api/sales/notify';

async function testWithNumber() {
    const testData = {
        phone: '01227072811', // The specific number to test
        saleData: {
            orderId: 'TEST-' + Date.now(),
            amount: '250.00',
            currency: 'EGP',
            customerName: 'Test Customer',
            date: new Date().toLocaleString(),
            paymentMethod: 'Cash',
            items: '3'
        }
    };

    console.log('🧪 Testing Sales Auto-Message Endpoint');
    console.log('=====================================\n');
    console.log('Phone Number:', testData.phone);
    console.log('Endpoint:', ENDPOINT);
    console.log('Test Data:', JSON.stringify(testData, null, 2));
    console.log('\n⏱️  Sending request...\n');

    const startTime = Date.now();

    try {
        const response = await fetch(ENDPOINT, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-API-Token': API_TOKEN
            },
            body: JSON.stringify(testData),
            signal: AbortSignal.timeout(10000) // 10 second timeout
        });

        const result = await response.json();
        const responseTime = Date.now() - startTime;

        if (response.ok) {
            console.log(`✅ SUCCESS! (Response time: ${responseTime}ms)`);
            console.log('Response:', JSON.stringify(result, null, 2));
            
            if (result.queued) {
                console.log('\n💡 Note: Message was queued and will be sent when WhatsApp is ready');
                console.log('   Check server logs to see when the message is actually sent.');
            }
        } else {
            console.log(`❌ FAILED! (Response time: ${responseTime}ms)`);
            console.log('Status:', response.status);
            console.log('Response:', JSON.stringify(result, null, 2));
        }
    } catch (error) {
        const responseTime = Date.now() - startTime;
        console.error(`❌ ERROR after ${responseTime}ms:`, error.message);
        
        if (error.name === 'AbortError' || error.name === 'TimeoutError') {
            console.error('\n⚠️  Request timed out!');
        } else {
            console.error('\nMake sure:');
            console.error('1. The server is running (npm start)');
            console.error('2. The endpoint URL is correct');
            console.error('3. The API token matches your .env file');
        }
    }
}

// Check if fetch is available (Node.js 18+)
if (typeof fetch === 'undefined') {
    console.error('❌ This script requires Node.js 18+ or install node-fetch');
    console.error('   Run: npm install node-fetch');
    process.exit(1);
}

testWithNumber();

