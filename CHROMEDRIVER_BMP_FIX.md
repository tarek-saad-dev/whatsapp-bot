# ChromeDriver BMP Character Support Fix

## Problem

ChromeDriver throws this error when sending messages with certain emojis:
```
ChromeDriver only supports characters in the BMP
```

## Explanation

### What is BMP?

**BMP (Basic Multilingual Plane)** is the first plane of Unicode, containing characters with code points from **U+0000 to U+FFFF** (0x0000 to 0xFFFF in hexadecimal).

### Why the Error?

ChromeDriver only supports characters in the BMP range. Characters outside this range (code points > 0xFFFF) cause the error.

### Character Support

✅ **Supported (BMP - 0x0000 to 0xFFFF):**
- All ASCII characters (0x00-0x7F)
- Latin characters (A-Z, a-z)
- Arabic characters (U+0600-U+06FF) - **Arabic is fully supported!**
- Basic punctuation
- Some older emojis (if they're in BMP range)

❌ **Not Supported (Non-BMP - > 0xFFFF):**
- Many newer emojis (Unicode 6.0+)
- Some special symbols
- Emojis with modifiers or skin tones
- Complex emoji sequences

## Solution

The code now includes two functions:

### 1. `sanitizeMessageToBMP(message)`
Filters out any characters with code points > 0xFFFF, keeping only BMP characters.

### 2. `replaceNonBMPEmojis(message)`
Replaces common emojis with text alternatives before sanitization, preserving the message intent.

## How It Works

```javascript
// Original message with emojis
const message = "🎉 Thank you! 💚";

// Step 1: Replace emojis with text
// "🎉 Thank you! 💚" → "[PARTY] Thank you! [GREEN HEART]"

// Step 2: Filter any remaining non-BMP characters
// Ensures only BMP characters remain

// Step 3: Send sanitized message
// ChromeDriver accepts it without errors
```

## Integration

The sanitization is automatically applied in `sendMessageInternal()`:

```javascript
// Message is sanitized before sending
let sanitizedMessage = replaceNonBMPEmojis(message);
sanitizedMessage = sanitizeMessageToBMP(sanitizedMessage);
await inputBox.sendKeys(sanitizedMessage, Key.ENTER);
```

## Examples

### ✅ Arabic Text (Works Fine)
```javascript
const message = "شكراً لك على الشراء"; // All Arabic chars are in BMP
// No sanitization needed - sends as-is
```

### ⚠️ Messages with Emojis
```javascript
const message = "🎉 Thank you for your purchase! 💚";
// Becomes: "[PARTY] Thank you for your purchase! [GREEN HEART]"
```

### ✅ Mixed Content
```javascript
const message = "شكراً! Thank you! 🎉";
// Arabic stays, emoji replaced: "شكراً! Thank you! [PARTY]"
```

## Customization

To add more emoji replacements, edit the `replacements` object in `replaceNonBMPEmojis()`:

```javascript
const replacements = {
    '💚': '[GREEN HEART]',
    '🎉': '[PARTY]',
    // Add your custom replacements here
    '🆕': '[NEW]',
};
```

## Testing

Test with different message types:

```javascript
// Test 1: Arabic only (should work)
"شكراً لك"

// Test 2: English with emojis (will be sanitized)
"Thank you! 🎉💚"

// Test 3: Mixed (Arabic stays, emojis replaced)
"شكراً! Thank you! 🎉"
```

## Notes

- **Arabic text is fully supported** - all Arabic characters are in BMP range
- Emojis are replaced with text alternatives to preserve message intent
- The sanitization is automatic - no code changes needed in your API calls
- If you see a warning log, it means the message was modified

