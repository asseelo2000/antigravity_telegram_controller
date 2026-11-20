import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getSettingsHtml } from './settings_view';
import * as os from 'os';
import { isScriptInjected } from './workbench_injector';
import { AccountManager } from './account_manager';
import { getAvailableSystemSounds } from './sound_alert';

export class TelegramSettingsProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'telegram-control-welcome';

    private _view?: vscode.WebviewView;

    constructor(
        private readonly context: vscode.ExtensionContext,
    ) { }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                this.context.extensionUri
            ]
        };

        this.updateHtml();

        webviewView.webview.onDidReceiveMessage(async (data) => {
            const config = vscode.workspace.getConfiguration('antigravityTelegramControl');
            switch (data.command) {
                case 'save':
                    await config.update('botToken', data.token, vscode.ConfigurationTarget.Global);
                    await config.update('allowedChatId', data.chatId, vscode.ConfigurationTarget.Global);
                    await config.update('debuggingPort', data.debuggingPort ?? 9222, vscode.ConfigurationTarget.Global);
                    await config.update('language', data.language || 'en', vscode.ConfigurationTarget.Global);
                    vscode.window.showInformationMessage('Telegram Settings Saved!');

                    // Restart bot
                    vscode.commands.executeCommand('antigravity-telegram-control.stopBot');
                    vscode.commands.executeCommand('antigravity-telegram-control.startBot');
                    break;

                case 'saveAgents':
                    try {
                        await config.update('agentsMsPath', data.agentsMsPath, vscode.ConfigurationTarget.Global);
                        await config.update('geminiMdPath', data.geminiMdPath, vscode.ConfigurationTarget.Global);

                        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
                        const msPath = data.agentsMsPath || (root ? path.join(root, 'agents.md') : undefined);
                        const mdPath = data.geminiMdPath || (root ? path.join(root, 'gemini.md') : undefined);

                        if (msPath) fs.writeFileSync(msPath, data.agentsMs, 'utf8');
                        if (mdPath) fs.writeFileSync(mdPath, data.geminiMd, 'utf8');

                        vscode.window.showInformationMessage('Agent configuration updated!');
                    } catch (e: any) {
                        vscode.window.showErrorMessage(`Failed to save agents: ${e.message}`);
                    }
                    break;

                case 'saveAuto':
                    try {
                        await config.update('autoRetry', data.autoRetry, vscode.ConfigurationTarget.Global);
                        if (typeof data.soundAlertEnabled === 'boolean') {
                            await config.update('soundAlertEnabled', data.soundAlertEnabled, vscode.ConfigurationTarget.Global);
                        }
                        if (typeof data.soundAlertFile === 'string') {
                            await config.update('soundAlertFile', data.soundAlertFile, vscode.ConfigurationTarget.Global);
                        }
                        if (typeof data.soundAlertVolume === 'number' && !isNaN(data.soundAlertVolume)) {
                            await config.update('soundAlertVolume', data.soundAlertVolume, vscode.ConfigurationTarget.Global);
                        }
                        await config.update('autoAccept', data.autoAccept, vscode.ConfigurationTarget.Global);
                        await config.update('autoAcceptInterval', data.autoAcceptInterval ?? 800, vscode.ConfigurationTarget.Global);
                        try {
                            await config.update('scrollEnabled', data.scrollEnabled ?? true, vscode.ConfigurationTarget.Global);
                        } catch (_e) { }
                        try {
                            await config.update('scrollPauseMs', data.scrollPauseMs ?? 7000, vscode.ConfigurationTarget.Global);
                        } catch (_e) { }
                        try {
                            await config.update('scrollIntervalMs', data.scrollIntervalMs ?? 500, vscode.ConfigurationTarget.Global);
                        } catch (_e) { }
                        await config.update('clickPatterns', data.clickPatterns ?? ["Allow", "Always Allow", "Run", "Keep Waiting", "Accept all", "Accept"], vscode.ConfigurationTarget.Global);
                        vscode.window.showInformationMessage('Automation settings updated!');
                    } catch (e: any) {
                        vscode.window.showErrorMessage(`Failed to save automation settings: ${e.message}`);
                    }
                    break;

                case 'saveMirror':
                    try {
                        await config.update('enableMirror', data.enableMirror, vscode.ConfigurationTarget.Global);
                        await config.update('mirrorPort', data.mirrorPort ?? 9999, vscode.ConfigurationTarget.Global);
                        await config.update('mirrorToken', data.mirrorToken || '', vscode.ConfigurationTarget.Global);
                        await config.update('enableTunnel', data.enableTunnel, vscode.ConfigurationTarget.Global);
                        await config.update('tunnelType', data.tunnelType || 'localhost.run', vscode.ConfigurationTarget.Global);
                        await config.update('ngrokAuthToken', data.ngrokAuthToken || '', vscode.ConfigurationTarget.Global);
                        vscode.window.showInformationMessage('Web Mirror settings updated!');
                    } catch (e: any) {
                        vscode.window.showErrorMessage(`Failed to save Web Mirror settings: ${e.message}`);
                    }
                    break;

                case 'resetStats':
                    await this.context.globalState.update('totalClicks', 0);
                    await this.context.globalState.update('clickStats', {});
                    await this.context.globalState.update('clickLog', []);
                    webviewView.webview.postMessage({ command: 'statsUpdated', clickStats: {}, totalClicks: 0 });
                    webviewView.webview.postMessage({ command: 'clickLogUpdate', log: [] });
                    break;

                case 'clearClickLog':
                    await this.context.globalState.update('clickLog', []);
                    webviewView.webview.postMessage({ command: 'clickLogUpdate', log: [] });
                    break;

                case 'getStats':
                    const totalClicks = this.context.globalState.get<number>('totalClicks') ?? 0;
                    const clickStats = this.context.globalState.get<Record<string, number>>('clickStats') ?? {};
                    webviewView.webview.postMessage({ command: 'statsUpdated', clickStats, totalClicks });
                    break;

                case 'getClickLog':
                    const log = this.context.globalState.get<Array<any>>('clickLog') ?? [];
                    webviewView.webview.postMessage({ command: 'clickLogUpdate', log });
                    break;

                case 'autofind':
                    try {
                        const home = os.homedir();
                        const geminiDir = path.join(home, '.gemini');
                        const results: any = { command: 'foundPaths' };

                        if (fs.existsSync(geminiDir)) {
                            const msPath = path.join(geminiDir, 'agents.md');
                            const mdPath = path.join(geminiDir, 'gemini.md');

                            if (fs.existsSync(msPath)) {
                                results.agentsMsPath = msPath;
                                results.agentsMs = fs.readFileSync(msPath, 'utf8');
                            }
                            if (fs.existsSync(mdPath)) {
                                results.geminiMdPath = mdPath;
                                results.geminiMd = fs.readFileSync(mdPath, 'utf8');
                            }

                            if (results.agentsMsPath || results.geminiMdPath) {
                                webviewView.webview.postMessage(results);
                                vscode.window.showInformationMessage('Found agent files in .gemini folder!');
                            } else {
                                vscode.window.showWarningMessage('No agent files found in .gemini folder.');
                            }
                        } else {
                            vscode.window.showWarningMessage('Could not find .gemini folder in home directory.');
                        }
                    } catch (e: any) {
                        vscode.window.showErrorMessage(`Search failed: ${e.message}`);
                    }
                    break;

                case 'registerCommands':
                    vscode.commands.executeCommand('antigravity-telegram-control.registerCommands', data.token, data.chatId);
                    break;

                case 'testSoundAlert':
                    vscode.commands.executeCommand('antigravity-telegram-control.testSoundAlert', data.soundAlertFile, data.soundAlertVolume);
                    break;

                case 'deleteCommands':
                    vscode.commands.executeCommand('antigravity-telegram-control.deleteCommands', data.token, data.chatId);
                    break;

                case 'injectScript':
                    vscode.commands.executeCommand('antigravity-telegram-control.injectScript');
                    break;

                case 'uninstallScript':
                    vscode.commands.executeCommand('antigravity-telegram-control.uninstallScript');
                    break;

                case 'loginNewAccount':
                    try {
                        const possibleCommands = [
                            'antigravity.login',
                            'antigravity.signIn',
                            'antigravity.authenticate',
                            'workbench.action.accounts',
                            'workbench.action.openAccounts',
                            'workbench.action.manageAccounts'
                        ];
                        let executed = false;
                        for (const cmd of possibleCommands) {
                            try {
                                await vscode.commands.executeCommand(cmd);
                                executed = true;
                                break;
                            } catch {}
                        }
                        
                        const action = await vscode.window.showInformationMessage(
                            '🔐 Opening Google OAuth login. After logging in successfully in your browser, click "Refresh & Save" to snapshot the new account into the list.',
                            'Refresh & Save'
                        );
                        if (action === 'Refresh & Save') {
                            this.updateHtml();
                            try {
                                const accountMgr = AccountManager.getInstance();
                                const saved = accountMgr.saveCurrentAccount();
                                if (saved) {
                                    vscode.window.showInformationMessage(`✅ Saved snapshot for new account: ${saved.name} (${saved.email})`);
                                    this.updateHtml();
                                }
                            } catch (err: any) {
                                vscode.window.showWarningMessage(`No new account detected: ${err.message}. Please click 🔄 Refresh Info after IDE updates.`);
                            }
                        } else {
                            this.updateHtml();
                        }
                    } catch (e: any) {
                        vscode.window.showErrorMessage(`Could not open login browser: ${e.message}`);
                    }
                    break;

                case 'refreshAccount':
                    try {
                        this.updateHtml();
                        vscode.window.showInformationMessage('🔄 Refreshed current account info from IDE.');
                    } catch (e: any) {
                        vscode.window.showErrorMessage(`Refresh failed: ${e.message}`);
                    }
                    break;

                case 'saveCurrentAccount':
                    try {
                        const accountMgr = AccountManager.getInstance();
                        const saved = accountMgr.saveCurrentAccount(data.name || undefined);
                        if (saved) {
                            vscode.window.showInformationMessage(`✅ Saved account snapshot: ${saved.name} (${saved.email})`);
                            this.updateHtml();
                        }
                    } catch (e: any) {
                        vscode.window.showErrorMessage(`Failed to save account: ${e.message}`);
                    }
                    break;

                case 'switchAccount':
                    try {
                        const accountMgr = AccountManager.getInstance();
                        const result = accountMgr.switchAccount(data.accountId);
                        this.updateHtml();
                        const choice = await vscode.window.showInformationMessage(
                            `✅ Switched to account ${result.account.name} (${result.account.email})! Reload IDE to synchronize.`,
                            'Reload Now'
                        );
                        if (choice === 'Reload Now') {
                            vscode.commands.executeCommand('workbench.action.reloadWindow');
                        }
                    } catch (e: any) {
                        vscode.window.showErrorMessage(`Failed to switch account: ${e.message}`);
                    }
                    break;

                case 'deleteAccount':
                    try {
                        const accountMgr = AccountManager.getInstance();
                        accountMgr.deleteAccount(data.accountId);
                        vscode.window.showInformationMessage(`🗑️ Removed account from saved storage.`);
                        this.updateHtml();
                    } catch (e: any) {
                        vscode.window.showErrorMessage(`Failed to remove account: ${e.message}`);
                    }
                    break;

                case 'rotateAccount':
                    try {
                        const accountMgr = AccountManager.getInstance();
                        const rotated = accountMgr.rotateAccount();
                        if (rotated) {
                            this.updateHtml();
                            vscode.window.showInformationMessage(`🔄 Rotated to account: ${rotated.name} (${rotated.email})`);
                        }
                    } catch (e: any) {
                        vscode.window.showErrorMessage(`Failed to rotate account: ${e.message}`);
                    }
                    break;

                case 'saveAccountsConfig':
                    try {
                        await config.update('autoRotateAccounts', data.autoRotateAccounts ?? false, vscode.ConfigurationTarget.Global);
                        vscode.window.showInformationMessage('Auto Rotate account settings saved!');
                    } catch (e: any) {
                        vscode.window.showErrorMessage(`Failed to save configuration: ${e.message}`);
                    }
                    break;
            }
        });
    }

    public updateHtml() {
        if (this._view) {
            const config = vscode.workspace.getConfiguration('antigravityTelegramControl');
            const token = config.get<string>('botToken') || '';
            const chatId = config.get<string>('allowedChatId') || '';
            const port = config.get<number>('debuggingPort') ?? 9222;
            const language = config.get<string>('language') || 'en';
            const agentsMsPath = config.get<string>('agentsMsPath') || '';
            const geminiMdPath = config.get<string>('geminiMdPath') || '';
            const autoRetry = config.get<boolean>('autoRetry') ?? false;
            const soundAlertEnabled = config.get<boolean>('soundAlertEnabled') ?? true;
            const soundAlertFile = config.get<string>('soundAlertFile') || '';
            const soundAlertVolume = config.get<number>('soundAlertVolume') ?? 300;
            const availableSystemSounds = getAvailableSystemSounds();
            const autoAccept = config.get<boolean>('autoAccept') ?? false;
            const autoAcceptInterval = config.get<number>('autoAcceptInterval') ?? 800;
            const enableMirror = config.get<boolean>('enableMirror') ?? false;
            const mirrorPort = config.get<number>('mirrorPort') ?? 9999;
            const mirrorToken = config.get<string>('mirrorToken') || '';
            const enableTunnel = config.get<boolean>('enableTunnel') ?? false;
            const tunnelType = config.get<string>('tunnelType') || 'localhost.run';
            const ngrokAuthToken = config.get<string>('ngrokAuthToken') || '';

            const scrollEnabled = config.get<boolean>('scrollEnabled') ?? true;
            const scrollPauseMs = config.get<number>('scrollPauseMs') ?? 7000;
            const scrollIntervalMs = config.get<number>('scrollIntervalMs') ?? 500;

            const clickPatterns = config.get<string[]>('clickPatterns') ?? ["Allow", "Always Allow", "Run", "Keep Waiting", "Accept all", "Accept"];
            
            const totalClicks = this.context.globalState.get<number>('totalClicks') ?? 0;
            const clickStats = this.context.globalState.get<Record<string, number>>('clickStats') ?? {};
            const clickLog = this.context.globalState.get<Array<any>>('clickLog') ?? [];

            const autoRotateAccounts = config.get<boolean>('autoRotateAccounts') ?? false;
            const accountMgr = AccountManager.getInstance();
            const currentAccount = accountMgr.getCurrentAccount();
            const storedAccounts = accountMgr.getStoredAccounts();

            let agentsMs = '';
            let geminiMd = '';

            try {
                const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
                const msPath = agentsMsPath || (root ? path.join(root, 'agents.md') : undefined);
                const mdPath = geminiMdPath || (root ? path.join(root, 'gemini.md') : undefined);

                if (msPath && fs.existsSync(msPath)) agentsMs = fs.readFileSync(msPath, 'utf8');
                if (mdPath && fs.existsSync(mdPath)) geminiMd = fs.readFileSync(mdPath, 'utf8');
            } catch (e) {
                console.error('Error reading agent files:', e);
            }

            this._view.webview.html = getSettingsHtml(
                token,
                chatId,
                port,
                language,
                agentsMs,
                geminiMd,
                agentsMsPath,
                geminiMdPath,
                autoRetry,
                autoAccept,
                autoAcceptInterval,
                enableMirror,
                mirrorPort,
                mirrorToken,
                enableTunnel,
                tunnelType,
                ngrokAuthToken,
                clickPatterns,
                totalClicks,
                clickStats,
                clickLog,
                isScriptInjected(),
                scrollEnabled,
                scrollPauseMs,
                scrollIntervalMs,
                storedAccounts,
                currentAccount,
                autoRotateAccounts,
                soundAlertEnabled,
                soundAlertFile,
                availableSystemSounds,
                soundAlertVolume
            );
        }
    }
}
