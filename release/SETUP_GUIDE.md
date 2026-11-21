# 🚀 Setup & Installation Guide | Antigravity Telegram Control

Welcome! This guide explains step-by-step how to install the **Antigravity Telegram Control** extension, create your Telegram bot, and connect them together to remotely control your Antigravity IDE and AI Agent directly from your phone.

---

## 📂 Exported Files (`exports/`)
* 📦 **`antigravity-telegram-control-1.0.14.vsix`**: Pre-built extension package ready for installation.
* 📄 **`دليل_التثبيت_والإعداد.md`**: Complete Arabic setup and installation guide.
* 📄 **`SETUP_GUIDE.md`**: Complete English setup and installation guide.

---

## 🛠️ Step 1: Install the Extension in Antigravity IDE

1. Open **Antigravity IDE**.
2. Navigate to the **Extensions** view in the Activity Bar (or press `Ctrl + Shift + X`).
3. Click the **`...` (Views and More Actions)** menu icon at the top right of the Extensions panel.
4. Select **Install from VSIX...**.
5. Browse and select the file:
   ```
   C:\Users\Aseel\Desktop\antigravity-telegram-control-main\exports\antigravity-telegram-control-1.0.14.vsix
   ```
6. Wait a few seconds until the confirmation notification appears:
   > *Successfully installed the extension 'Antigravity Telegram Control'!*

---

## 🤖 Step 2: Create Your Telegram Bot via `@BotFather`

1. Open **Telegram** on your mobile phone or desktop.
2. In the search bar, search for the official bot: **`@BotFather`** (verified with a blue checkmark).
3. Click **Start** or send:
   ```text
   /newbot
   ```
4. Enter a display name for your bot:
   - Example: `Antigravity Assistant`
5. Enter a username for your bot ending in `bot`:
   - Example: `aseel_antigravity_bot`
6. `@BotFather` will send you your unique **HTTP API Token**:
   ```text
   7123456789:AAHxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   ```
7. **Copy and save this token**; you will need it in Step 4.

---

## ⚡ Step 3: Launch Antigravity with Remote Debugging Port

> [!IMPORTANT]
> To enable Chrome DevTools Protocol (CDP) features (reading Agent webview, expanding chat details via `/expand`, checking live quotas `/status`, and screen captures), Antigravity must be started with port `9222`.

### Desktop Shortcut Method (Recommended):
1. Right-click your **Antigravity** desktop shortcut and select **Properties**.
2. Under the **Shortcut** tab, locate the **Target** field.
3. At the end of the line (after the quotation mark), add a space and:
   ```text
   --remote-debugging-port=9222
   ```
   *(e.g.: `"C:\Users\Aseel\AppData\Local\Programs\Antigravity\Antigravity.exe" --remote-debugging-port=9222`)*
4. Click **Apply** and **OK**, then launch Antigravity using this shortcut.

### Or via PowerShell / Command Prompt:
```powershell
antigravity --remote-debugging-port=9222
```

---

## 🔗 Step 4: Configure & Connect the Bot in Antigravity

1. In **Antigravity**, open Settings (`Ctrl + ,`).
2. Search for `Antigravity Telegram Control`.
3. Set the following options:
   * **`Bot Token`**: Paste the token obtained from `@BotFather`.
   * **`Debugging Port`**: Ensure it is set to `9222`.
   * **`Language`**: Choose `ar` (Arabic) or `en` (English).
4. **Start the Bot**:
   - Press `Ctrl + Shift + P` and execute:
     ```text
     Telegram: Start Bot
     ```
   - A notification will confirm that the bot has started.
5. **Set Allowed Chat ID (Security)**:
   - Open your bot in Telegram and send `/start`.
   - The bot or IDE notification will display your **Chat ID** (e.g. `Your Chat ID is: 123456789`).
   - Copy this ID and paste it into:
     **`antigravityTelegramControl.allowedChatId`**.
   - *(This ensures only you can interact with the bot and execute commands)*.
6. **Register Slash Commands in Telegram**:
   - Press `Ctrl + Shift + P` and execute:
     ```text
     Telegram: Register Slash Commands
     ```
   - All slash commands will now show up automatically in Telegram with rich descriptions when typing `/`.

---

## 🎮 Step 5: Quick Command Reference

| Command | Description |
| :--- | :--- |
| **`/menu`** or **`/start`** | **Interactive Command Center Widget**: Categorized buttons with instant search to run any command without typing! |
| **`/status`** | **Comprehensive Telemetry Dashboard**: Real-time Quota, Agent health, and System resources (CPU, RAM, Uptime). |
| **`/files`** | **Workspace File Browser**: Interactively explore workspace folders with navigation buttons. |
| **`/getfile <path>`** | **Download File to Phone**: Receive any workspace file directly in chat (documents up to 50MB, images, or formatted code). |
| **`/extensions`** | **Sidebar Extensions Manager**: Inspect VS Code views (GitHub Actions, Git, etc.) with screenshot captures. |
| **`/expand`** | **Expand Live Changes**: Auto-expands hidden changes & steps in agent chat and sends a visual snapshot. |
| **`/changes`** | **Codebase Changes Summary**: Lists modified files and executed terminal commands in current session. |
| **`/history [n]`** | **Chat History**: Fetch last N messages from active agent conversation. |
| **`/answer [text]`** | **Smart Questions**: Interactive inline buttons for multiple choice options + `📸 Context Frame` button. |
| **`/screenshot`** | Capture high-resolution screenshot of current active IDE screen. |
| **`/ask <prompt>`** | Send a new prompt or instruction to Antigravity AI Agent. |

---

Enjoy full remote control of your Antigravity IDE and AI Agent right from your phone! 🎉
