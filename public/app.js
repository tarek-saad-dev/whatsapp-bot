const API_BASE = '/api';

// Tab switching
document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        const tabName = btn.dataset.tab;
        switchTab(tabName);
    });
});

function switchTab(tabName) {
    // Update buttons
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelector(`[data-tab="${tabName}"]`).classList.add('active');
    
    // Update content
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    document.getElementById(`${tabName}-tab`).classList.add('active');
    
    // Load data based on tab
    if (tabName === 'campaigns') {
        loadCampaigns();
    } else if (tabName === 'customers') {
        loadCustomers();
    }
}

// Campaign Management
async function loadCampaigns() {
    try {
        const response = await fetch(`${API_BASE}/campaigns`);
        const campaigns = await response.json();
        displayCampaigns(campaigns);
    } catch (error) {
        console.error('Error loading campaigns:', error);
        showError('Failed to load campaigns');
    }
}

function displayCampaigns(campaigns) {
    const container = document.getElementById('campaigns-list');
    
    if (campaigns.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <h3>No campaigns yet</h3>
                <p>Create your first campaign to get started!</p>
            </div>
        `;
        return;
    }
    
    const segmentLabels = {
        'just_now': 'Just Purchased',
        'today': 'Today',
        'this_week': 'This Week',
        'two_weeks': '2 Weeks Ago',
        'one_month': '1 Month Ago'
    };
    
    container.innerHTML = campaigns.map(campaign => `
        <div class="campaign-card">
            <span class="segment-badge">${segmentLabels[campaign.segmentType] || campaign.segmentType}</span>
            <h3>${escapeHtml(campaign.name)}</h3>
            <p class="description">${escapeHtml(campaign.description || 'No description')}</p>
            <div class="meta">
                <span class="phone-count">${campaign.phoneNumbers.length} customers</span>
                <span>${formatDate(campaign.createdAt)}</span>
            </div>
            <div class="actions">
                <button class="btn btn-primary" onclick="viewCampaign('${campaign.id}')">View</button>
                <button class="btn btn-secondary" onclick="refreshCampaign('${campaign.id}')">Refresh</button>
                <button class="btn btn-danger" onclick="deleteCampaign('${campaign.id}')">Delete</button>
            </div>
        </div>
    `).join('');
}

async function viewCampaign(id) {
    try {
        const response = await fetch(`${API_BASE}/campaigns/${id}`);
        const campaign = await response.json();
        showCampaignModal(campaign);
    } catch (error) {
        console.error('Error loading campaign:', error);
        showError('Failed to load campaign details');
    }
}

function showCampaignModal(campaign) {
    const modal = document.getElementById('campaign-modal');
    const body = document.getElementById('campaign-modal-body');
    
    const segmentLabels = {
        'just_now': 'Just Purchased (Right Now)',
        'today': 'Purchased/Visited Today',
        'this_week': 'Visited This Week',
        'two_weeks': 'Last Visit 2 Weeks Ago',
        'one_month': 'Last Visit 1 Month Ago'
    };
    
    body.innerHTML = `
        <div class="campaign-detail">
            <h3>${escapeHtml(campaign.name)}</h3>
            <div class="detail-row">
                <div class="detail-label">Description</div>
                <div class="detail-value">${escapeHtml(campaign.description || 'No description')}</div>
            </div>
            <div class="detail-row">
                <div class="detail-label">Segment Type</div>
                <div class="detail-value">${segmentLabels[campaign.segmentType] || campaign.segmentType}</div>
            </div>
            <div class="detail-row">
                <div class="detail-label">Message Template</div>
                <div class="detail-value">${escapeHtml(campaign.messageTemplate)}</div>
            </div>
            <div class="detail-row">
                <div class="detail-label">Phone Numbers (${campaign.phoneNumbers.length})</div>
                <div class="phone-list">
                    ${campaign.phoneNumbers.length > 0 
                        ? campaign.phoneNumbers.map(phone => `<div class="phone-item">${escapeHtml(phone)}</div>`).join('')
                        : '<div class="phone-item">No customers in this segment</div>'
                    }
                </div>
            </div>
            <div class="detail-row">
                <div class="detail-label">Status</div>
                <div class="detail-value">${campaign.status}</div>
            </div>
            <div class="detail-row">
                <div class="detail-label">Created</div>
                <div class="detail-value">${formatDate(campaign.createdAt)}</div>
            </div>
            <div class="form-actions" style="margin-top: 20px;">
                <button class="btn btn-success" onclick="executeCampaign('${campaign.id}')">Execute Campaign</button>
                <button class="btn btn-secondary" onclick="refreshCampaign('${campaign.id}')">Refresh Segment</button>
            </div>
        </div>
    `;
    
    modal.style.display = 'block';
}

function closeCampaignModal() {
    document.getElementById('campaign-modal').style.display = 'none';
}

async function refreshCampaign(id) {
    try {
        const response = await fetch(`${API_BASE}/campaigns/${id}/refresh`, { method: 'POST' });
        const campaign = await response.json();
        showSuccess('Campaign refreshed successfully');
        loadCampaigns();
        if (document.getElementById('campaign-modal').style.display === 'block') {
            showCampaignModal(campaign);
        }
    } catch (error) {
        console.error('Error refreshing campaign:', error);
        showError('Failed to refresh campaign');
    }
}

async function deleteCampaign(id) {
    if (!confirm('Are you sure you want to delete this campaign?')) {
        return;
    }
    
    try {
        await fetch(`${API_BASE}/campaigns/${id}`, { method: 'DELETE' });
        showSuccess('Campaign deleted successfully');
        loadCampaigns();
    } catch (error) {
        console.error('Error deleting campaign:', error);
        showError('Failed to delete campaign');
    }
}

async function refreshCampaigns() {
    await loadCampaigns();
    showSuccess('Campaigns refreshed');
}

// Create Campaign
async function previewSegment() {
    const segmentType = document.getElementById('segment-type').value;
    const previewDiv = document.getElementById('segment-preview');
    
    if (!segmentType) {
        previewDiv.innerHTML = '';
        return;
    }
    
    previewDiv.innerHTML = '<div class="loading">Loading preview...</div>';
    
    try {
        const response = await fetch(`${API_BASE}/campaigns/preview/${segmentType}`);
        const data = await response.json();
        previewDiv.innerHTML = `
            <div class="count">${data.count} customers found in this segment</div>
            ${data.count > 0 ? `<small>Preview: ${data.customers.slice(0, 5).map(c => c.phone).join(', ')}${data.count > 5 ? '...' : ''}</small>` : ''}
        `;
    } catch (error) {
        previewDiv.innerHTML = '<div style="color: #e74c3c;">Error loading preview</div>';
    }
}

async function createCampaign(event) {
    event.preventDefault();
    
    const formData = {
        name: document.getElementById('campaign-name').value,
        description: document.getElementById('campaign-description').value,
        messageTemplate: document.getElementById('message-template').value,
        segmentType: document.getElementById('segment-type').value
    };
    
    try {
        const response = await fetch(`${API_BASE}/campaigns`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(formData)
        });
        
        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Failed to create campaign');
        }
        
        const campaign = await response.json();
        showSuccess(`Campaign "${campaign.name}" created successfully with ${campaign.phoneNumbers.length} customers!`);
        resetForm();
        switchTab('campaigns');
        loadCampaigns();
    } catch (error) {
        console.error('Error creating campaign:', error);
        showError(error.message || 'Failed to create campaign');
    }
}

function resetForm() {
    document.getElementById('create-campaign-form').reset();
    document.getElementById('segment-preview').innerHTML = '';
}

// Customer Management
async function loadCustomers() {
    try {
        const response = await fetch(`${API_BASE}/customers`);
        const customers = await response.json();
        displayCustomers(customers);
    } catch (error) {
        console.error('Error loading customers:', error);
        showError('Failed to load customers');
    }
}

function displayCustomers(customers) {
    const container = document.getElementById('customers-list');
    
    if (customers.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <h3>No customers yet</h3>
                <p>Add customers to start creating campaigns!</p>
            </div>
        `;
        return;
    }
    
    container.innerHTML = `
        <table class="customers-table">
            <thead>
                <tr>
                    <th>Phone</th>
                    <th>Name</th>
                    <th>Last Visit</th>
                    <th>Last Purchase</th>
                    <th>Actions</th>
                </tr>
            </thead>
            <tbody>
                ${customers.map(customer => `
                    <tr>
                        <td>${escapeHtml(customer.phone)}</td>
                        <td>${escapeHtml(customer.name || '-')}</td>
                        <td>${customer.lastVisitDate ? formatDate(customer.lastVisitDate) : '-'}</td>
                        <td>${customer.lastPurchaseDate ? formatDate(customer.lastPurchaseDate) : '-'}</td>
                        <td>
                            <button class="btn btn-secondary" style="padding: 5px 10px; font-size: 0.85em;" onclick="editCustomer('${customer.phone}')">Edit</button>
                            <button class="btn btn-danger" style="padding: 5px 10px; font-size: 0.85em;" onclick="deleteCustomer('${customer.phone}')">Delete</button>
                        </td>
                    </tr>
                `).join('')}
            </tbody>
        </table>
    `;
}

function showAddCustomerModal() {
    document.getElementById('customer-form').reset();
    document.getElementById('customer-modal').style.display = 'block';
}

function closeCustomerModal() {
    document.getElementById('customer-modal').style.display = 'none';
}

async function saveCustomer(event) {
    event.preventDefault();
    
    const formData = {
        phone: document.getElementById('customer-phone').value,
        name: document.getElementById('customer-name').value,
        lastVisitDate: document.getElementById('last-visit-date').value || null,
        lastPurchaseDate: document.getElementById('last-purchase-date').value || null
    };
    
    try {
        const response = await fetch(`${API_BASE}/customers`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(formData)
        });
        
        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Failed to save customer');
        }
        
        showSuccess('Customer saved successfully');
        closeCustomerModal();
        loadCustomers();
    } catch (error) {
        console.error('Error saving customer:', error);
        showError(error.message || 'Failed to save customer');
    }
}

async function editCustomer(phone) {
    try {
        const response = await fetch(`${API_BASE}/customers/${encodeURIComponent(phone)}`);
        const customer = await response.json();
        
        document.getElementById('customer-phone').value = customer.phone;
        document.getElementById('customer-name').value = customer.name || '';
        document.getElementById('last-visit-date').value = customer.lastVisitDate ? customer.lastVisitDate.split('T')[0] : '';
        document.getElementById('last-purchase-date').value = customer.lastPurchaseDate ? customer.lastPurchaseDate.split('T')[0] : '';
        
        document.getElementById('customer-modal').style.display = 'block';
    } catch (error) {
        console.error('Error loading customer:', error);
        showError('Failed to load customer');
    }
}

async function deleteCustomer(phone) {
    if (!confirm(`Are you sure you want to delete customer ${phone}?`)) {
        return;
    }
    
    try {
        await fetch(`${API_BASE}/customers/${encodeURIComponent(phone)}`, { method: 'DELETE' });
        showSuccess('Customer deleted successfully');
        loadCustomers();
    } catch (error) {
        console.error('Error deleting customer:', error);
        showError('Failed to delete customer');
    }
}

// Execute Campaign (integrate with WhatsApp bot)
async function executeCampaign(campaignId) {
    if (!confirm('This will send messages to all customers in this campaign. Continue?')) {
        return;
    }
    
    try {
        const response = await fetch(`${API_BASE}/campaigns/${campaignId}/execute`, {
            method: 'POST'
        });
        
        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Failed to execute campaign');
        }
        
        const result = await response.json();
        showSuccess(`Campaign execution initiated! ${result.totalMessages} messages will be sent.\n\nTo send messages, run: node bot-campaign.js ${campaignId}`);
        console.log('Campaign execution:', result);
    } catch (error) {
        console.error('Error executing campaign:', error);
        showError(error.message || 'Failed to execute campaign');
    }
}

// Utility functions
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function formatDate(dateString) {
    if (!dateString) return '-';
    const date = new Date(dateString);
    return date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function showSuccess(message) {
    alert('✓ ' + message); // Simple alert for now
}

function showError(message) {
    alert('✗ ' + message); // Simple alert for now
}

// Close modals when clicking outside
window.onclick = function(event) {
    const campaignModal = document.getElementById('campaign-modal');
    const customerModal = document.getElementById('customer-modal');
    if (event.target === campaignModal) {
        closeCampaignModal();
    }
    if (event.target === customerModal) {
        closeCustomerModal();
    }
}

// Load campaigns on page load
document.addEventListener('DOMContentLoaded', () => {
    loadCampaigns();
});

