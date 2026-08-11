const whatsappService = require('./services/whatsappService');

console.log('🧹 Cleaning up WhatsApp service state (profile preserved)...');
whatsappService.cleanup();
console.log('✅ Cleanup complete. The dedicated Chrome profile was preserved.');
