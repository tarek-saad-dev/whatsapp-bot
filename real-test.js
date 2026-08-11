const http = require('http');
const fs = require('fs');
const path = require('path');

const endpoint = 'http://localhost:3000/api/whatsapp/send';
const phone = '01557994946';

const payloads = [
  {
    type: 'sale',
    phone,
    customerName: 'طارق',
    invoiceNumber: 'INV-10025',
    total: 350,
    paymentMethod: 'كاش',
    branchName: 'جليم',
    employeeName: 'محمد',
    services: ['حلاقة شعر', 'تحديد دقن']
  },
  {
    type: 'booking',
    phone,
    customerName: 'طارق',
    bookingId: 'BK-1055',
    bookingDate: '2026-06-23',
    bookingTime: '05:30 PM',
    branchName: 'جليم',
    barberName: 'محمد',
    services: ['حلاقة شعر', 'تحديد دقن'],
    bookingLink: 'https://cutsaloon.com/'
  },
  {
    type: 'first_time',
    phone,
    customerName: 'طارق',
    branchName: 'جليم',
    bookingLink: 'https://cutsaloon.com/'
  },
  {
    type: 'employee_sale',
    phone,
    customerName: 'أحمد',
    invoiceNumber: 'INV-123',
    services: ['حلاقة', 'تحديد دقن'],
    branchName: 'جليم'
  },
  {
    type: 'employee_advance',
    phone: '01039244023',
    customerName: 'زياد',
    amount: 500,
    invoiceNumber: 'ADV-001',
    paymentMethod: 'كاش',
    branchName: 'جليم',
    notes: 'سلفة شهرية'
  },
  {
    type: 'employee_funding',
    phone: '01039244023',
    customerName: 'زياد',
    amount: 10,
    invoiceNumber: 'FUND-1207426',
    paymentMethod: 'كاش',
    branchName: 'جليم',
    notes: 'إيراد موظف'
  }
];

function sendRequest(payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = http.request(
      endpoint,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        }
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(data) });
          } catch (e) {
            resolve({ status: res.statusCode, body: data });
          }
        });
      }
    );

    req.on('error', reject);
    req.setTimeout(300000, () => {
      req.destroy();
      reject(new Error('Request timed out'));
    });

    req.write(body);
    req.end();
  });
}

async function run() {
  const results = [];
  for (const payload of payloads) {
    console.log(`Sending ${payload.type} message...`);
    const start = Date.now();
    try {
      const result = await sendRequest(payload);
      results.push({
        type: payload.type,
        durationMs: Date.now() - start,
        status: result.status,
        response: result.body
      });
    } catch (error) {
      results.push({
        type: payload.type,
        durationMs: Date.now() - start,
        error: error.message
      });
    }
  }

  const outputPath = path.join(__dirname, 'real-test-results.json');
  fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
  console.log(`Results saved to ${outputPath}`);
  console.log(JSON.stringify(results, null, 2));
}

run();
