# Building the WhatsApp Bot Server Executable

This guide explains how to create an `.exe` file to run the WhatsApp Bot Server without needing to open a terminal and type commands.

## ⚡ Quick Start (Recommended - No Build Required!)

The **easiest** way is to use the batch files - no compilation needed:

1. **Start the server:**
   - Double-click `start-server.bat`
   - The server will start automatically in a console window

2. **Test a message (optional):**
   - Double-click `test-message.bat`
   - This sends a test message to verify everything works

**That's it!** No build step required. The batch files work immediately.

### Creating a Desktop Shortcut

1. Right-click `start-server.bat`
2. Select "Create shortcut"
3. Drag the shortcut to your desktop
4. Rename it to "WhatsApp Bot Server"
5. (Optional) Right-click → Properties → Change Icon to customize

## Building an Executable (.exe) File

If you prefer a single `.exe` file instead of batch files, follow these steps:

## Building an Executable (.exe) File

### Prerequisites

1. **Node.js** must be installed (v14 or higher)
2. **npm** (comes with Node.js)

### Steps

1. **Install build dependencies:**
   ```bash
   npm install
   ```
   This will install `pkg` (the tool that creates executables) along with other dependencies.

2. **Build the executable:**
   ```bash
   npm run build:exe
   ```
   
   This will create `whatsapp-bot-server.exe` in the project root.

3. **Run the executable:**
   - Double-click `whatsapp-bot-server.exe`
   - The server will start automatically
   - A console window will open showing server logs

### Build Options

- **64-bit Windows only:**
  ```bash
  npm run build:exe
  ```

- **Both 32-bit and 64-bit Windows:**
  ```bash
  npm run build:exe:all
  ```

## Important Notes

### ⚠️ Limitations of Compiled Executables

**Note:** Due to the complexity of bundling Selenium WebDriver and ChromeDriver, the `.exe` approach may have limitations. The batch file method (`start-server.bat`) is recommended for most users.

1. **Chrome/Selenium Dependencies:**
   - The executable will still need Chrome and ChromeDriver installed
   - These cannot be bundled into the .exe
   - Make sure Chrome is installed on the target machine
   - Node.js modules with native bindings may not work perfectly

2. **Environment Variables:**
   - The `.env` file should be in the same directory as the .exe
   - Or set environment variables in the system

3. **File Structure:**
   - The executable should be in the project root directory
   - Keep the `public`, `routes`, `services`, `models`, and `data` folders in the same directory
   - Or use the `pkg` assets configuration (already set up)

4. **Alternative: PowerShell to EXE**
   - You can also compile `launcher.ps1` to .exe using PS2EXE
   - Install: `Install-Module -Name ps2exe`
   - Build: `Invoke-ps2exe -inputFile launcher.ps1 -outputFile whatsapp-bot-server.exe`

## Summary: Which Method to Use?

| Method | Pros | Cons | Best For |
|--------|------|------|----------|
| **Batch File** (`start-server.bat`) | ✅ Works immediately<br>✅ No build step<br>✅ Reliable | ⚠️ Requires Node.js installed | **Most users** ⭐ Recommended |
| **pkg .exe** | ✅ Single file<br>✅ Looks professional | ⚠️ Complex build<br>⚠️ May have issues with Selenium<br>⚠️ Large file size | Advanced users |
| **PowerShell .exe** | ✅ Native Windows<br>✅ Can compile to .exe | ⚠️ Requires PS2EXE module<br>⚠️ Still needs Node.js | Windows-focused users |

**Recommendation:** Use `start-server.bat` - it's the simplest and most reliable option!

## Troubleshooting

### "Node.js is not installed"
- Install Node.js from https://nodejs.org/
- Make sure to add it to PATH during installation

### "Cannot find module" errors
- Run `npm install` in the project directory
- Make sure all dependencies are installed

### Chrome doesn't open
- See `RUNNING_INSTRUCTIONS.md` for Chrome display requirements
- The executable must run in an interactive Windows session

### Executable is large
- This is normal - it includes Node.js runtime
- Typical size: 40-60 MB

## Distribution

If you want to distribute the executable to other machines:

1. **Copy these files/folders:**
   - `whatsapp-bot-server.exe`
   - `.env` (or provide instructions to create it)
   - `public/` folder
   - `routes/` folder
   - `services/` folder
   - `models/` folder
   - `data/` folder (if exists)

2. **Requirements on target machine:**
   - Google Chrome installed
   - Windows OS (matching the build target)

3. **First run:**
   - User must scan QR code once
   - After that, session persists (if `KEEP_LOGIN=true`)

