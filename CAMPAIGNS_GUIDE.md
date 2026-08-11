# Campaigns Feature Guide

## Overview

The Campaigns feature allows you to create and manage separate promotional campaigns for different customer segments based on their visit/purchase recency. Each campaign has its own message template and automatically targets customers based on their behavior.

## Features

- **Customer Segmentation**: Automatically segment customers by visit/purchase recency
- **Campaign Management**: Create, edit, and manage multiple campaigns
- **Message Templates**: Customize messages per campaign with personalization
- **Customer Management**: Add and manage customer data with visit/purchase dates
- **Campaign Execution**: Execute campaigns to send messages via WhatsApp

## Customer Segments

The system supports 5 predefined segments:

1. **Just Purchased (Right Now)**: Customers who purchased within the last 5 minutes
2. **Purchased/Visited Today**: All customers whose last visit/purchase was today
3. **Visited This Week**: Customers who visited within the current week
4. **Last Visit 2 Weeks Ago**: Customers whose last visit was approximately 14 days ago (12-16 days)
5. **Last Visit 1 Month Ago**: Customers whose last visit was approximately 30 days ago (28-32 days)

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Start the Server

```bash
npm start
```

The server will start on `http://localhost:3000` (or the port specified in `.env`)

### 3. Access the UI

Open your browser and navigate to `http://localhost:3000`

## Usage

### Adding Customers

1. Go to the **Customers** tab
2. Click **Add Customer**
3. Fill in:
   - Phone number (required)
   - Name (optional)
   - Last Visit Date (optional)
   - Last Purchase Date (optional)
4. Click **Save Customer**

**Bulk Import**: You can also import customers via the API:
```bash
POST /api/customers/bulk-import
Content-Type: application/json

{
  "customers": [
    {
      "phone": "201234567890",
      "name": "John Doe",
      "lastVisitDate": "2024-01-15T10:00:00Z",
      "lastPurchaseDate": "2024-01-15T10:00:00Z"
    }
  ]
}
```

### Creating a Campaign

1. Go to the **Create Campaign** tab
2. Fill in:
   - **Campaign Name**: A descriptive name (e.g., "Thank You - Just Purchased")
   - **Description**: Optional description
   - **Customer Segment**: Select one of the 5 segment types
   - **Message Template**: Your message text (use `{{name}}` for personalization)
3. The system will automatically preview how many customers match the segment
4. Click **Create Campaign**

### Managing Campaigns

- **View**: Click "View" to see campaign details, message template, and customer list
- **Refresh**: Click "Refresh" to recalculate the customer segment (useful after adding new customers)
- **Delete**: Click "Delete" to remove a campaign

### Executing a Campaign

1. View the campaign details
2. Click **Execute Campaign**
3. The system will prepare the campaign data
4. To actually send messages, run:
   ```bash
   node bot-campaign.js <campaign-id>
   ```
   Or use:
   ```bash
   npm run campaign <campaign-id>
   ```

## API Endpoints

### Campaigns

- `GET /api/campaigns` - Get all campaigns
- `GET /api/campaigns/:id` - Get a specific campaign
- `POST /api/campaigns` - Create a new campaign
- `PUT /api/campaigns/:id` - Update a campaign
- `DELETE /api/campaigns/:id` - Delete a campaign
- `POST /api/campaigns/:id/refresh` - Refresh customer segment
- `POST /api/campaigns/:id/execute` - Prepare campaign for execution
- `GET /api/campaigns/preview/:segmentType` - Preview customers in a segment

### Customers

- `GET /api/customers` - Get all customers
- `GET /api/customers/:phone` - Get a specific customer
- `POST /api/customers` - Create/update a customer
- `PUT /api/customers/:phone` - Update a customer
- `DELETE /api/customers/:phone` - Delete a customer
- `POST /api/customers/bulk-import` - Bulk import customers

## Data Storage

All data is stored in JSON files in the `data/` directory:
- `data/customers.json` - Customer data
- `data/campaigns.json` - Campaign data

These files are created automatically when you first use the system.

## Message Personalization

In your message templates, you can use:
- `{{name}}` - Will be replaced with the customer's name (or "Customer" if not available)

Example message template:
```
Hello {{name}}! Thank you for your recent purchase. We'd love to offer you a special discount on your next visit!
```

## Example Workflow

1. **Add Customers**: Import or manually add customers with their visit/purchase dates
2. **Create Campaigns**: Create separate campaigns for each segment you want to target
3. **Customize Messages**: Write personalized messages for each campaign
4. **Refresh Segments**: Periodically refresh campaigns to update customer lists
5. **Execute**: When ready, execute campaigns to send messages via WhatsApp

## Notes

- Customer segments are calculated in real-time based on current date/time
- The "Just Purchased" segment looks for purchases within the last 5 minutes
- Date ranges for "2 weeks ago" and "1 month ago" have a ±2 day window for flexibility
- Campaign execution requires the WhatsApp bot to be properly configured (see main README.md)

## Troubleshooting

**No customers in segment**: 
- Make sure customers have the appropriate visit/purchase dates set
- Check that dates are in the correct format (ISO 8601)
- Try refreshing the campaign

**Campaign execution fails**:
- Ensure WhatsApp Web is properly configured
- Check that phone numbers are in the correct format
- Verify the bot has access to WhatsApp Web

