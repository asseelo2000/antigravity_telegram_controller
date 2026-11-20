# Changelog

All notable changes to the **Antigravity Telegram Control** extension will be documented in this file.

---

## v1.0.14 — Interactive Agent Questions Remote Control
*   **❓ Real-time Question Watcher**: Background watcher polling IDE modal dialogs (`ask_question` tool calls) and alerting Telegram immediately.
*   **🔘 Inline Keyboard Options & Skip**: Formatted options list with 1-tap inline buttons and quick Skip button.
*   **💬 Multiple Answering Methods**: Answer directly by clicking inline buttons, typing option numbers (e.g. `1`), or writing custom text responses.
*   **⚡ Snappy Submit Engine**: Optimized pointer and mouse event dispatching with snappy 50ms submit polling intervals to prevent CDP timeout.
*   **🌐 Full Arabic & English Localization**: Complete bilingual question prompts, status updates, and actionable alerts.

## v1.0.12 — Clean Project Backup Remote Command (/backup)
*   **📦 Remote Project Backup**: Archive the currently active project workspace into a clean ZIP archive directly via `/backup` (aliases: `/zip`, `/project_backup`).
*   **🚫 Smart Ignore Engine**: Excludes all files and folders ignored by `.gitignore` as well as common framework dependency trees (`node_modules`, `vendor`, `.venv`, `__pycache__`, `target`, `bin`, `obj`, `.gradle`, `build`, `.git`, etc.).
*   **📤 Direct Telegram Transmission**: Sends the clean ZIP file directly as a document attachment in Telegram for archives up to 50MB.
*   **💾 Local Safety Fallback**: If an archive exceeds the 50MB Telegram Bot API limit, retains the local archive file and provides the user with the full absolute path and statistics.
*   **🌐 Full Bilingual Localization**: Complete Arabic and English localized messages, stats (file count and human-readable size), and command descriptions.

## v1.0.11 — Dual Confirmation (Enter Key + Click) on Conversation Switch
*   **🎯 Auto Confirm Prompt**: Automatically confirms the "Open in current window" prompt when switching conversations across workspaces.
*   **🖱️ Dual Action (Enter + Mouse Click)**: Dispatches both hardware-level CDP `Enter` key events and direct native mouse click coordinates on the first option ("Open in current window").
*   **⚡ Reliable QuickPick Polling**: Actively detects the QuickPick prompt appearance without fixed blocking delays.

## v1.0.10 — Support Model Thinking Effort Submenus (Low / Medium / High)
*   **🎯 Thinking Effort Support**: Automatically inspects and expands model effort submenus (such as `Gemini 3.8 Flash (Low)`, `Gemini 3.8 Flash (Medium)`, `Gemini 3.8 Flash (High)`).
*   **🔀 Exact Mode Switching**: Switch directly to any effort mode using inline buttons, numbers, or effort keywords (e.g. `/switchmodel high`, `/switchmodel 3`).
*   **🟢 Precise Status**: Real-time detection of the currently active effort level directly from the IDE.

## v1.0.9 — AI Model Selection & Switching Remote Control
*   **🤖 List Available Models**: View all AI models available in the Antigravity agent chat (Gemini, Claude Sonnet/Opus, GPT-OSS) along with active indicators via `/models` or `/model`.
*   **🔀 Remote Model Switching**: Switch the active AI model remotely from Telegram using `/switchmodel <number|name>` or `/switch_model <number|name>`.
*   **🔘 1-Tap Inline Buttons**: Render interactive inline keyboard buttons in Telegram to switch between models instantly with a single tap.
*   **🎯 Direct Parameter Support**: Switch models directly using number index (e.g. `/model 2`) or model name substring (e.g. `/model claude`).
*   **🌐 Full Bilingual Localization**: Complete Arabic and English localized messages and command hints.

## v1.0.8 — Fix Single Project Selection & Prevent Sequential Open Loop
*   **🔒 Single Project Isolation**: Fixed issue where replayed pending updates could cause multiple recent projects to open sequentially upon window reload.
*   **🧹 Immediate Inline Keyboard Dismissal**: Automatically removes the inline keyboard on button click to eliminate duplicate or accidental clicks.
*   **🚫 Drop Pending Updates on Startup**: Enabled `dropPendingUpdates: true` on bot initialization to prevent Telegram from replaying unconfirmed callback queries after IDE window reload.
*   **🔑 Unique Folder Identifier Mapping**: Encoded safe unique folder IDs in button callbacks instead of fragile changing indices.
*   **⏱️ Graceful Flush & Disconnect**: Added proper network buffer flushing and bot shutdown before window reload.

## v1.0.7 — Recent Folder & Workspace Opener Remote Control
*   **📂 Open Recent Folder / Workspace**: List and open recently used folders and workspaces directly from Telegram using `/recent` (or `/openrecent`, `/recentfolder`).
*   **🔘 1-Tap Inline Buttons**: View up to 10 interactive Telegram inline keyboard buttons to quickly open any recent project in the current window with a single tap.
*   **🎯 Direct Parameter Support**: Open folders directly by sequential number (e.g. `/recent 2`) or by name (e.g. `/recent CyberTik`).
*   **🛡️ Dual-Layer Discovery**: Automatically queries internal workbench services with disk-level `state.vscdb` parser fallback for 100% reliable detection.
*   **🌐 Full Bilingual Localization**: Complete Arabic and English localized messages and status indicators.

## v1.0.6 — Agent Conversation Switching & Interactive Telegram Buttons
*   **🔀 Remote Conversation Switching**: Switch between Antigravity agent conversations directly from Telegram using `/switchchat <index|title>` or `/switch_chat <index|title>`.
*   **🔘 Interactive Inline Buttons**: `/chats` and `/switchchat` now render interactive inline keyboard buttons in Telegram, enabling instant 1-tap switching between conversations.
*   **⚡ Direct Argument Support in /chats**: Support switching directly via `/chat <index>` or `/chats <index>`.
*   **🌐 Full Bilingual Support**: Comprehensive translations and messages for switching actions in English and Arabic.

## v1.0.5 — Start New Conversation Remote Control
*   **➕ New Agent Conversation**: Start a fresh Antigravity agent conversation remotely via `/newchat`.

## v1.0.1 — Multi-Account Management & Quota Auto-Rotation
*   **👥 Multi-Account Management**: Seamlessly manage, snapshot, and switch between multiple Google/Antigravity accounts directly in Antigravity IDE and remotely via Telegram.
*   **🤖 Telegram Bot Commands**: Added `/accounts` (list all accounts & active status), `/switch <id|index>` (instant account switching), `/save_account [name]` (snapshot current login), and `/rotate_account` (round-robin account cycling).
*   **🔄 Auto-Rotation on Quota Depletion**: Automatically rotates to the next available saved account whenever the active account's 5-Hour or Daily quota reaches 98%+ limit, keeping agents working 24/7 without interruption.
*   **💻 Native Sidebar Accounts Tab**: Dedicated "Accounts" panel in Webview settings with one-click snapshot, account switching, deletion, auto-rotation settings, and a `🔄 Refresh Info` button.
*   **⚡ Enhanced Language Server Process Discovery**: Completely overhauled process discovery logic across Windows, macOS, and Linux to reliably detect the Antigravity backend language server processes.
*   **🔒 Robust CSRF & Port Extraction**: Improved regex parsing to extract dynamic port, CSRF token, and extension server endpoints directly from process command lines without false positives.
*   **📊 Status Bar Quota HUD Alignment**: Clean `%/%` percentage readout for prompt credit and model quotas directly on the VS Code status bar.
*   **🎯 Consolidated Automation & Stats**: Merged Click Statistics dashboard and recent logs directly into the **Auto (Automation Settings)** tab for a streamlined UI.

## v1.0.0 — Major Official Release
*   **📜 Smart Auto Scroll**: Automatically scrolls the Antigravity chat panel while the agent generates content, pauses when you manually scroll up to read, and resumes when new content is generated.
*   **🔀 Dynamic Multi-Instance Support**: Micro HTTP IPC server dynamically binds within port range `48787-48850` with port auto-discovery, allowing multiple Antigravity IDE windows to run simultaneously without conflicts.
*   **🛡️ Checksum & Cache Self-Healing**: Automatically recalculates SHA-256 checksums in `product.json` (`updateProductChecksums()`) and clears V8 bytecode cache (`clearV8CodeCache()`) to resolve VS Code "Corrupt Installation" alerts.
*   **🎯 DOM Protection & Chat-Only Accept**: Intelligent DOM context filtering protects diff editors, merge views, inline hunk actions, and code viewports while safely auto-approving agent chat steps.
*   **📊 Click Stats Dashboard**: Real-time click history, top button crown badge, progress bars, and stats reset controls in the Webview UI.
*   **⚡ Native Win32 Keep Waiting Clicker**: Automatic win32 post-message execution for native Windows system dialogs.

## v0.0.9
*   **☁️ Cloudflare Tunnel Integration**: Added support for Cloudflare Tunnel (`cloudflared`) to securely expose the Web Mirror to the public internet using TryCloudflare, with the link automatically sent to Telegram.
*   **💬 Responsive & Smart Chat Interface**: Optimized the Web Mirror UI with a responsive design for mobile screens (under 600px wide) and low-height screen viewports (under 520px height), ensuring layout visibility and clean spacing when virtual keyboards are open.
*   **✍️ Multiline Message Input**: Replaced the single-line input text field in the Web Mirror client with a smart `textarea` that auto-adjusts its height up to 150px and supports Shift+Enter for new lines and Enter to send.
*   **🐛 Client Web connection fix**: Restored the missing DOM element `<span id="statusText"></span>` to resolve JavaScript runtime crashes during client connection establishment, enabling the real-time screen stream to load properly.

## v0.0.8
*   **🌐 Web Mirror Public Tunneling**: Seamlessly expose the Web Mirror server to the public internet. Supports **localhost.run** (free SSH tunnel with zero credentials/setup required) and **ngrok** (using your global auth token or settings-defined token). Once started, the public URL is automatically posted directly to your Telegram chat.
*   **⚡ Local Auto-Accept Manager**: Added a background worker that polls and automatically approves Agent steps and terminal executions in the IDE. Uses a hybrid approach combining VS Code native commands and CDP-based Shadow DOM clicking.
*   **⚙️ Automation Configuration UI**: Added a dedicated "Automation" panel to the custom settings view to easily configure Auto-Accept and Auto-Retry options.
*   **🛠️ Expanded Target Matching**: Deep Shadow DOM traversal recognizes various interactive button tokens (`accept all`, `run`, `always allow`, etc.) and automatically expands collapsed steps when they require input.

## v0.0.7
*   **🌐 Interactive Web Mirror Server**: Added a local HTTP/WebSocket stream server. Casts the cropped Agent view onto a canvas in any browser with support for mouse interaction translation and prompt injection.
*   **📊 Status Bar Quota HUD**: Dynamically locates the Antigravity backend language server, connects using scraped CSRF tokens, and shows remaining prompt credits / model usage percentage on the VS Code status bar.
*   **🔒 Secure Command Scoping**: Configured command scopes to hide bot slash commands from general view, showing suggestions only to the authorized Chat ID.

## v0.0.6
*   **🗂️ Tabbed UI Interface**: Organized settings into intuitive tabs: "Settings" for Telegram bot configuration and "Agents" for file management.
*   **📝 Integrated Agent Editors**: Edit your `agents.md` and `gemini.md` files directly within the VS Code sidebar without switching contexts.
*   **📍 Custom Path Support**: Full support for absolute file paths, allowing you to manage agent files anywhere on your system (e.g., in `.gemini` home folder).
*   **🔍 Auto-find Intelligence**: New "Auto-find" button that automatically scans your home directory for established `.gemini` configurations and pre-fills them.
*   **🛠️ Workflow Optimization**: Improved save logic that synchronizes changes between the editor and the filesystem seamlessly.

## v0.0.5
*   **⚡ Improved Smart Detection**: Enhanced detection of Agent chat elements using Shadow DOM traversal, ensuring the bot always "sees" the UI regardless of how deep it's nested.
*   **📜 Auto-Scroll Logic**: Added intelligence to automatically scroll the chat container to the bottom after detection or before taking a screenshot.
*   **🎯 Targeted Capture**: Prioritizes the correct VS Code webviews using title-based matching and intelligent element scoring.
