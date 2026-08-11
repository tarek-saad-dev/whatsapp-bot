# Phase 6 — UI Pages Documentation

## Overview

Phase 6 implements a complete web UI for managing offers and campaigns. All pages are simple HTML/CSS with embedded JavaScript for API integration.

## Pages Created

### 1. Create Offer (`create-offer.html`)

**Purpose:** Create a new promotional offer

**Features:**
- Form to create offer with:
  - Name (required)
  - Description
  - Min/Max Age
  - Form URL (optional)
  - Status (draft/active/expired)
- Auto-redirects to targeting page after creation
- Success/error message display

**Navigation:**
- Back to Dashboard link
- Redirects to `offer-targeting.html` after creation

### 2. Offer Targeting (`offer-targeting.html`)

**Purpose:** Configure targeting rules for an offer

**Features:**
- Form to add targeting rules:
  - Gender
  - City
  - Marital Status
  - Came From
  - Last Visit Date Range
  - Minimum Visits
  - Minimum Spend
- List of existing targeting rules
- Delete targeting rules
- Build Audience button
- Link to Summary page after building audience

**URL Parameters:**
- `offerId` - Required, passed from create-offer page

**Navigation:**
- Back to Dashboard link
- Link to Summary page (appears after building audience)

### 3. Offer Summary (`offer-summary.html`)

**Purpose:** Preview offer details, targeting, audience, and message before creating campaign

**Features:**
- Display offer details (name, status, age range, form URL)
- Show all targeting rules
- Display audience count and preview (first 5 members)
- Show message preview
- Create Campaign button
- Refresh button

**URL Parameters:**
- `offerId` - Required

**Navigation:**
- Back to Dashboard link
- Create Campaign button → redirects to campaign details
- View Campaigns link → goes to campaign list

### 4. Campaign List (`campaign-list.html`)

**Purpose:** View all offer-based campaigns

**Features:**
- Grid display of all campaigns
- Campaign cards showing:
  - Campaign ID
  - Offer ID
  - Status badge (draft/sending/completed)
  - Statistics (Total, Sent, Failed)
  - Progress bar
  - Created/Started/Completed dates
- Click card to view details
- Auto-refresh every 30 seconds
- Create New Offer button
- Refresh button

**Navigation:**
- Click campaign card → goes to campaign details
- Create New Offer button → goes to create offer page

### 5. Campaign Details (`campaign-details.html`)

**Purpose:** View detailed campaign progress and messages

**Features:**
- Campaign information section:
  - Campaign ID, Offer ID
  - Status
  - Total Recipients
  - Created/Started/Completed timestamps
- Progress statistics:
  - Total, Sent, Pending, Failed counts
  - Visual progress bar
- Messages table:
  - Filter by status (All/Pending/Sent/Failed)
  - Client ID, Phone, Status, Sent At, Error
  - Refresh button
- Start Campaign button (only shown for draft campaigns)
- Auto-refresh every 10 seconds

**URL Parameters:**
- `campaignId` - Required

**Navigation:**
- Back to Campaign List link
- Back to List button

## Design Features

### Consistent Styling
- All pages use the same `styles.css`
- Gradient header with purple theme
- White content cards with rounded corners
- Consistent button styles
- Responsive design

### User Experience
- Clear navigation between pages
- Loading states
- Success/error messages
- Auto-refresh for real-time updates
- Confirmation dialogs for important actions

### Color Coding
- **Status Badges:**
  - Draft: Gray
  - Sending: Yellow/Warning
  - Completed: Green/Success
- **Message Status:**
  - Pending: Yellow
  - Sent: Green
  - Failed: Red

## API Integration

All pages use the REST API endpoints:

- `GET /api/offers` - List offers
- `POST /api/offers` - Create offer
- `GET /api/offers/:id` - Get offer
- `POST /api/offers/:id/targeting` - Add targeting rule
- `GET /api/offers/:id/targeting` - Get targeting rules
- `DELETE /api/offers/:id/targeting/:ruleId` - Delete targeting rule
- `POST /api/offers/:id/build-audience` - Build audience
- `GET /api/offers/:id/summary` - Get offer summary
- `POST /api/campaigns` - Create campaign
- `GET /api/campaigns/offers` - List campaigns
- `GET /api/campaigns/offers/:id` - Get campaign
- `GET /api/campaigns/offers/:id/stats` - Get campaign stats
- `GET /api/campaigns/offers/:id/messages` - Get campaign messages
- `POST /api/campaigns/offers/:id/start` - Start campaign

## User Flow

### Complete Flow:

1. **Create Offer**
   - Navigate to `create-offer.html`
   - Fill form and submit
   - Auto-redirects to targeting page

2. **Configure Targeting**
   - Add targeting rules
   - Build audience
   - Click "View Summary" link

3. **Review Summary**
   - Review offer details
   - Check audience count and preview
   - Preview message
   - Click "Create Campaign"

4. **View Campaign List**
   - See all campaigns
   - Click on campaign to view details

5. **Campaign Details**
   - View progress
   - See message status
   - Start campaign (if draft)
   - Monitor real-time updates

## File Structure

```
public/
├── index.html              # Main dashboard (existing)
├── create-offer.html      # Create offer page
├── offer-targeting.html    # Targeting rules page
├── offer-summary.html     # Summary page
├── campaign-list.html     # Campaign list page
├── campaign-details.html  # Campaign details page
├── styles.css            # Shared styles (updated)
└── app.js                 # Main dashboard JS (existing)
```

## Testing

### Manual Testing Steps:

1. **Test Create Offer:**
   - Open `http://localhost:3000/create-offer.html`
   - Fill form and submit
   - Verify redirect to targeting page

2. **Test Targeting:**
   - Add targeting rules
   - Build audience
   - Verify summary link appears

3. **Test Summary:**
   - Review all sections
   - Create campaign
   - Verify redirect to campaign details

4. **Test Campaign List:**
   - View all campaigns
   - Click on campaign
   - Verify navigation to details

5. **Test Campaign Details:**
   - View campaign info
   - Check progress stats
   - Start campaign (if draft)
   - Monitor message updates

## Notes

- All pages are standalone HTML files
- No build process required
- Works with existing API endpoints
- Responsive design for mobile/tablet
- Auto-refresh for real-time updates
- Error handling with user-friendly messages



