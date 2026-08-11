/**
 * Campaign Worker Service
 * Processes pending campaign messages and sends them via WhatsApp
 */

const campaignMessageModel = require('../models/campaignMessage');
const offerCampaignModel = require('../models/offerCampaign');
const whatsappService = require('./whatsappService');

// Configuration
const BATCH_SIZE = parseInt(process.env.CAMPAIGN_BATCH_SIZE || '5'); // Messages per batch
const BATCH_DELAY_MS = parseInt(process.env.CAMPAIGN_BATCH_DELAY_MS || '10000'); // 10 seconds between batches
const MESSAGE_DELAY_MS = parseInt(process.env.CAMPAIGN_MESSAGE_DELAY_MS || '40000'); // 40 seconds between each message
const POLL_INTERVAL_MS = parseInt(process.env.CAMPAIGN_POLL_INTERVAL_MS || '5000'); // Check every 5 seconds

let isProcessing = false;
let workerInterval = null;
let isWorkerRunning = false;

/**
 * Get all pending messages across all campaigns
 */
function getAllPendingMessages() {
    return campaignMessageModel.getAllPendingMessages();
}

/**
 * Get pending messages for a specific campaign
 */
function getPendingMessagesByCampaign(campaignId) {
    return campaignMessageModel.getMessagesByStatus(campaignId, 'pending');
}

/**
 * Process a single message
 */
async function processMessage(message) {
    try {
        console.log(`📤 Processing message ${message.id} for phone ${message.phone}`);
        
        // Send via WhatsApp service
        const result = await whatsappService.sendMessage(message.phone, message.messageBody);
        
        if (result.success) {
            // Mark as sent
            campaignMessageModel.markAsSent(message.id);
            
            // Update campaign sent count
            offerCampaignModel.incrementSentCount(message.campaignId);
            
            console.log(`✅ Message ${message.id} sent successfully to ${message.phone}`);
            return { success: true, messageId: message.id };
        } else {
            // Mark as failed
            const errorMsg = result.error || 'Unknown error';
            campaignMessageModel.markAsFailed(message.id, errorMsg);
            
            // Update campaign failed count
            offerCampaignModel.incrementFailedCount(message.campaignId);
            
            console.error(`❌ Message ${message.id} failed: ${errorMsg}`);
            return { success: false, messageId: message.id, error: errorMsg };
        }
    } catch (error) {
        // Mark as failed
        const errorMsg = error.message || 'Exception during send';
        campaignMessageModel.markAsFailed(message.id, errorMsg);
        
        // Update campaign failed count
        offerCampaignModel.incrementFailedCount(message.campaignId);
        
        console.error(`❌ Exception processing message ${message.id}:`, error.message);
        return { success: false, messageId: message.id, error: errorMsg };
    }
}

/**
 * Process a batch of messages
 */
async function processBatch(messages) {
    if (messages.length === 0) {
        return { processed: 0, succeeded: 0, failed: 0 };
    }
    
    console.log(`🔄 Processing batch of ${messages.length} messages...`);
    
    const results = [];
    
    // Process messages sequentially to respect rate limits
    for (let i = 0; i < messages.length; i++) {
        const message = messages[i];
        const result = await processMessage(message);
        results.push(result);
        
        // Delay between messages (40 seconds by default)
        // Skip delay after the last message in the batch
        if (i < messages.length - 1) {
            console.log(`   ⏳ Waiting ${MESSAGE_DELAY_MS / 1000}s before next message...`);
            await sleep(MESSAGE_DELAY_MS);
        }
    }
    
    const succeeded = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;
    
    console.log(`✅ Batch complete: ${succeeded} succeeded, ${failed} failed`);
    
    return {
        processed: messages.length,
        succeeded,
        failed
    };
}

/**
 * Check and update campaign completion status
 */
function checkCampaignCompletion(campaignId) {
    const stats = campaignMessageModel.getMessageStats(campaignId);
    const campaign = offerCampaignModel.getCampaignById(campaignId);
    
    if (!campaign) {
        return;
    }
    
    // If no pending messages, mark campaign as completed
    if (stats.pending === 0 && campaign.status !== 'completed') {
        const totalProcessed = stats.sent + stats.failed;
        
        if (totalProcessed > 0) {
            console.log(`✅ Campaign ${campaignId} completed: ${stats.sent} sent, ${stats.failed} failed`);
            offerCampaignModel.updateCampaign(campaignId, {
                status: 'completed'
            });
        }
    }
}

/**
 * Process all pending messages (main worker function)
 */
async function processPendingMessages() {
    if (isProcessing) {
        console.log('⏸️  Worker already processing, skipping this cycle');
        return;
    }
    
    isProcessing = true;
    
    try {
        // Get all pending messages
        const pendingMessages = getAllPendingMessages();
        
        if (pendingMessages.length === 0) {
            // No pending messages, but check for campaigns that need completion status update
            const allCampaigns = offerCampaignModel.getAllCampaigns();
            for (const campaign of allCampaigns) {
                if (campaign.status === 'sending') {
                    checkCampaignCompletion(campaign.id);
                }
            }
            isProcessing = false;
            return;
        }
        
        console.log(`📬 Found ${pendingMessages.length} pending message(s)`);
        
        // Group messages by campaign for better tracking
        const messagesByCampaign = {};
        for (const msg of pendingMessages) {
            if (!messagesByCampaign[msg.campaignId]) {
                messagesByCampaign[msg.campaignId] = [];
            }
            messagesByCampaign[msg.campaignId].push(msg);
        }
        
        // Process each campaign's messages
        for (const [campaignId, messages] of Object.entries(messagesByCampaign)) {
            // Process in batches
            const batches = [];
            for (let i = 0; i < messages.length; i += BATCH_SIZE) {
                batches.push(messages.slice(i, i + BATCH_SIZE));
            }
            
            console.log(`📦 Campaign ${campaignId}: Processing ${messages.length} messages in ${batches.length} batch(es)`);
            
            for (let i = 0; i < batches.length; i++) {
                const batch = batches[i];
                console.log(`   Batch ${i + 1}/${batches.length} (${batch.length} messages)`);
                
                await processBatch(batch);
                
                // Delay between batches (except for last batch)
                if (i < batches.length - 1) {
                    console.log(`   ⏳ Waiting ${BATCH_DELAY_MS / 1000}s before next batch...`);
                    await sleep(BATCH_DELAY_MS);
                }
            }
            
            // Check if campaign is complete
            checkCampaignCompletion(campaignId);
        }
        
    } catch (error) {
        console.error('❌ Error in worker process:', error);
    } finally {
        isProcessing = false;
    }
}

/**
 * Start the campaign worker
 */
function startWorker() {
    if (isWorkerRunning) {
        console.log('⚠️  Campaign worker is already running');
        return;
    }
    
    console.log('🚀 Starting campaign worker...');
    console.log(`   Batch size: ${BATCH_SIZE}`);
    console.log(`   Message delay: ${MESSAGE_DELAY_MS / 1000}s between messages`);
    console.log(`   Batch delay: ${BATCH_DELAY_MS / 1000}s between batches`);
    console.log(`   Poll interval: ${POLL_INTERVAL_MS / 1000}s`);
    
    isWorkerRunning = true;
    
    // Process immediately on start
    processPendingMessages().catch(err => {
        console.error('❌ Error in initial worker run:', err);
    });
    
    // Then process periodically
    workerInterval = setInterval(() => {
        processPendingMessages().catch(err => {
            console.error('❌ Error in periodic worker run:', err);
        });
    }, POLL_INTERVAL_MS);
    
    console.log('✅ Campaign worker started');
}

/**
 * Stop the campaign worker
 */
function stopWorker() {
    if (!isWorkerRunning) {
        console.log('⚠️  Campaign worker is not running');
        return;
    }
    
    console.log('🛑 Stopping campaign worker...');
    
    if (workerInterval) {
        clearInterval(workerInterval);
        workerInterval = null;
    }
    
    isWorkerRunning = false;
    isProcessing = false;
    
    console.log('✅ Campaign worker stopped');
}

/**
 * Process messages for a specific campaign (manual trigger)
 */
async function processCampaignMessages(campaignId) {
    const pendingMessages = getPendingMessagesByCampaign(campaignId);
    
    if (pendingMessages.length === 0) {
        console.log(`ℹ️  No pending messages for campaign ${campaignId}`);
        checkCampaignCompletion(campaignId);
        return { processed: 0, succeeded: 0, failed: 0 };
    }
    
    console.log(`🔄 Processing ${pendingMessages.length} messages for campaign ${campaignId}`);
    
    // Process in batches
    const batches = [];
    for (let i = 0; i < pendingMessages.length; i += BATCH_SIZE) {
        batches.push(pendingMessages.slice(i, i + BATCH_SIZE));
    }
    
    let totalProcessed = 0;
    let totalSucceeded = 0;
    let totalFailed = 0;
    
    for (let i = 0; i < batches.length; i++) {
        const batch = batches[i];
        const result = await processBatch(batch);
        
        totalProcessed += result.processed;
        totalSucceeded += result.succeeded;
        totalFailed += result.failed;
        
        // Delay between batches (except for last batch)
        if (i < batches.length - 1) {
            await sleep(BATCH_DELAY_MS);
        }
    }
    
    // Check completion
    checkCampaignCompletion(campaignId);
    
    return {
        processed: totalProcessed,
        succeeded: totalSucceeded,
        failed: totalFailed
    };
}

/**
 * Sleep utility
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = {
    startWorker,
    stopWorker,
    processPendingMessages,
    processCampaignMessages,
    isWorkerRunning: () => isWorkerRunning,
    isProcessing: () => isProcessing
};

