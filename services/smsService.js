const https = require('https');
const http = require('http');
const url = require('url');

const SMS_HUB_API_URL = process.env.SMS_HUB_API_URL || 'https://hubapi.advansystelecom.com/api/bulkSMS/ForwardSMS';
const SMS_HUB_API_KEY = process.env.SMS_HUB_API_KEY || '';
const SMS_HUB_SENDER_NAME = process.env.SMS_HUB_SENDER_NAME || 'Cut Salon';

/**
 * Send SMS via Advansys Telecom SMS Hub API
 * @param {string} phone - Phone number in international format (e.g., 2010xxxxxxx)
 * @param {string} message - SMS message text
 * @returns {Promise<{success: boolean, data?: object, error?: string}>}
 */
async function sendSMS(phone, message) {
    if (!SMS_HUB_API_KEY) {
        console.error('❌ SMS_HUB_API_KEY not configured in .env');
        return { success: false, error: 'SMS API key not configured' };
    }

    // Format phone: remove leading 0, ensure starts with 20 (Egypt)
    const formattedPhone = phone.toString().replace(/^0/, '20');

    const requestId = Date.now().toString();

    const body = JSON.stringify({
        SenderName: SMS_HUB_SENDER_NAME,
        RequestID: requestId,
        PhoneNumber: formattedPhone,
        Message: message
    });

    console.log(`📱 Sending SMS to ${formattedPhone} via SMS Hub...`);

    return new Promise((resolve) => {
        const parsedUrl = new URL(SMS_HUB_API_URL);
        const isHttps = parsedUrl.protocol === 'https:';
        const lib = isHttps ? https : http;

        const options = {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port || (isHttps ? 443 : 80),
            path: parsedUrl.pathname,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'apiKey': SMS_HUB_API_KEY,
                'Content-Length': Buffer.byteLength(body)
            }
        };

        const req = lib.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    console.log(`✅ SMS Hub response (${res.statusCode}):`, JSON.stringify(parsed));
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        resolve({ success: true, data: parsed });
                    } else {
                        resolve({ success: false, error: `HTTP ${res.statusCode}`, data: parsed });
                    }
                } catch (e) {
                    console.log(`📨 SMS Hub raw response (${res.statusCode}):`, data);
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        resolve({ success: true, data: data });
                    } else {
                        resolve({ success: false, error: `HTTP ${res.statusCode}: ${data}` });
                    }
                }
            });
        });

        req.on('error', (err) => {
            console.error('❌ SMS Hub request error:', err.message);
            resolve({ success: false, error: err.message });
        });

        req.write(body);
        req.end();
    });
}

module.exports = { sendSMS };
