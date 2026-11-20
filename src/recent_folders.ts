import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * Interface representing a recently opened folder or workspace item
 */
export interface RecentFolderItem {
    // 1-based sequential index for display and quick selection
    index: number;
    // Friendly display name (folder or workspace name)
    name: string;
    // Absolute filesystem path to the folder or workspace file
    fsPath: string;
    // VS Code URI instance
    uri: vscode.Uri;
    // Whether this entry is a multi-root .code-workspace file
    isWorkspace: boolean;
    // Whether this folder is the currently active workspace in the IDE
    isCurrent: boolean;
}

/**
 * Helper to safely parse recent items from state.vscdb storage as fallback
 */
function getRecentFromVscdb(): any[] {
    // List of candidate paths to Antigravity IDE global storage database
    const candidatePaths: string[] = [
        path.join(process.env.APPDATA || '', 'Antigravity IDE', 'User', 'globalStorage', 'state.vscdb'),
        path.join(os.homedir(), 'AppData', 'Roaming', 'Antigravity IDE', 'User', 'globalStorage', 'state.vscdb'),
        path.join(os.homedir(), '.config', 'Antigravity IDE', 'User', 'globalStorage', 'state.vscdb'),
        path.join(process.env.APPDATA || '', 'Code', 'User', 'globalStorage', 'state.vscdb'),
    ];

    for (const dbPath of candidatePaths) {
        if (!fs.existsSync(dbPath)) {
            continue;
        }
        try {
            // Read binary buffer of SQLite database file
            const buf = fs.readFileSync(dbPath);
            const str = buf.toString('utf8');
            const key = 'history.recentlyOpenedPathsList';
            // Search backwards across occurrences of key to locate valid JSON payload
            let lastIdx = str.lastIndexOf(key);
            while (lastIdx !== -1) {
                const slice = str.slice(lastIdx);
                const jsonStart = slice.indexOf('{"entries":');
                if (jsonStart !== -1) {
                    // Balanced brace parser to safely extract valid JSON string
                    let depth = 0;
                    let end = -1;
                    for (let i = jsonStart; i < slice.length; i++) {
                        if (slice[i] === '{') {
                            depth++;
                        } else if (slice[i] === '}') {
                            depth--;
                            if (depth === 0) {
                                end = i + 1;
                                break;
                            }
                        }
                    }

                    if (end !== -1) {
                        try {
                            const jsonStr = slice.slice(jsonStart, end);
                            const parsed = JSON.parse(jsonStr);
                            if (Array.isArray(parsed.entries)) {
                                return parsed.entries;
                            }
                        } catch (_) { /* try previous occurrence if parsing fails */ }
                    }
                }
                lastIdx = str.lastIndexOf(key, lastIdx - 1);
            }
        } catch (e) {
            console.warn('[RecentFolders] Error reading state.vscdb fallback:', e);
        }
    }
    return [];
}

/**
 * Retrieve list of recently opened folders and workspaces
 */
export async function getRecentFolders(): Promise<RecentFolderItem[]> {
    // Collect normalized paths of currently active workspace folders
    const currentFolders = (vscode.workspace.workspaceFolders || []).map(f =>
        path.normalize(f.uri.fsPath.toLowerCase())
    );

    const items: RecentFolderItem[] = [];
    const seenPaths = new Set<string>();

    // 1. Try VS Code internal API command '_workbench.getRecentlyOpened'
    let rawEntries: any[] = [];
    try {
        const recent = await vscode.commands.executeCommand<any>('_workbench.getRecentlyOpened');
        if (recent && Array.isArray(recent.workspaces)) {
            rawEntries = recent.workspaces;
        }
    } catch (e) {
        console.warn('[RecentFolders] _workbench.getRecentlyOpened command failed:', e);
    }

    // 2. If internal command returned empty, fallback to reading state.vscdb directly
    if (rawEntries.length === 0) {
        rawEntries = getRecentFromVscdb();
    }

    // Process raw entries and normalize into RecentFolderItem objects
    for (const entry of rawEntries) {
        let uri: vscode.Uri | undefined;
        let isWorkspace = false;
        const label: string | undefined = entry.label;

        if (entry.folderUri) {
            if (typeof entry.folderUri === 'string') {
                uri = vscode.Uri.parse(entry.folderUri);
            } else if (entry.folderUri instanceof vscode.Uri) {
                uri = entry.folderUri;
            } else if (entry.folderUri.path || entry.folderUri.fsPath) {
                uri = vscode.Uri.file(entry.folderUri.fsPath || entry.folderUri.path);
            }
        } else if (entry.workspace && entry.workspace.configPath) {
            isWorkspace = true;
            const configPath = entry.workspace.configPath;
            if (typeof configPath === 'string') {
                uri = vscode.Uri.parse(configPath);
            } else if (configPath instanceof vscode.Uri) {
                uri = configPath;
            } else if (configPath.path || configPath.fsPath) {
                uri = vscode.Uri.file(configPath.fsPath || configPath.path);
            }
        }

        if (!uri) {
            continue;
        }

        const fsPath = uri.fsPath;
        if (!fsPath) {
            continue;
        }

        // Verify folder or workspace file exists on disk
        if (!fs.existsSync(fsPath)) {
            continue;
        }

        const normalized = path.normalize(fsPath.toLowerCase());

        // Deduplicate paths
        if (seenPaths.has(normalized)) {
            continue;
        }
        seenPaths.add(normalized);

        // Derive user-friendly folder or workspace name
        const name = label || path.basename(fsPath) || fsPath;
        const isCurrent = currentFolders.includes(normalized);

        items.push({
            index: items.length + 1,
            name,
            fsPath,
            uri,
            isWorkspace,
            isCurrent
        });
    }

    return items;
}

/**
 * Open a specified recent folder or workspace in the current IDE window
 */
export async function openRecentFolder(item: RecentFolderItem): Promise<{ success: boolean; message?: string }> {
    try {
        // Open folder in current window as requested by user
        await vscode.commands.executeCommand('vscode.openFolder', item.uri, { forceNewWindow: false });
        return { success: true };
    } catch (e: any) {
        console.error('[RecentFolders] Failed to open folder:', e);
        return { success: false, message: e.message || String(e) };
    }
}
