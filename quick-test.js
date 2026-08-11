// Quick test to verify endpoint responds
require('dotenv').config();

const API_TOKEN = process.env.SQL_TRIGGER_TOKEN || 'your-secret-token-change-this';

async function quickTest() {
    const start = Date.now();
    
    try {
        const response = await fetch('http://localhost:3000/api/sales/notify', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-API-Token': API_TOKEN
            },
            body: JSON.stringify({
                phone: '201234567890',
                saleData: {
                    orderId: 'QUICK-TEST',
                    amount: '100'
                }
            }),
            signal: AbortSignal.timeout(3000) // 3 second timeout
        });
        
        const result = await response.json();
        const elapsed = Date.now() - start;
        
        console.log(`✅ SUCCESS in ${elapsed}ms`);
        console.log(JSON.stringify(result, null, 2));
    } catch (error) {
        const elapsed = Date.now() - start;
        console.log(`❌ FAILED after ${elapsed}ms: ${error.message}`);
    }
}

quickTest();

