// src/file_browser.ts
// Interactive visual file browser and workspace navigator for Antigravity Telegram Control

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export interface FileEntry {
    name: string;
    fullPath: string;
    isDirectory: boolean;
    size?: number;
    extension?: string;
}

// Common directories and files excluded from display for performance and cleanliness
const IGNORED_NAMES = new Set([
    'node_modules', '.git', '.svn', '__pycache__', 'venv', '.venv',
    'env', '.env', 'build', 'dist', 'out', 'bin', 'obj', '.gradle',
    'target', '.dart_tool', 'Pods', '.idea', '.vs', '.cache', '.turbo',
    '.next', '.nuxt', '.output', 'coverage'
]);

// File extension to icon mapping
const FILE_ICONS: Record<string, string> = {
    '.ts': '🔷', '.tsx': '⚛️', '.js': '🟨', '.jsx': '⚛️',
    '.json': '📋', '.md': '📝', '.html': '🌐', '.css': '🎨',
    '.scss': '🎨', '.py': '🐍', '.cs': '💜', '.rs': '🦀',
    '.go': '🐹', '.java': '☕', '.php': '🐘', '.rb': '💎',
    '.sh': '🖥️', '.bat': '⚙️', '.ps1': '⚙️',
    '.yaml': '⚙️', '.yml': '⚙️', '.env': '🔑',
    '.sql': '🗄️', '.xml': '📄', '.svg': '🖼️', '.png': '🖼️',
    '.jpg': '🖼️', '.jpeg': '🖼️', '.gif': '🖼️', '.webp': '🖼️',
    '.ico': '🖼️', '.bmp': '🖼️',
    '.zip': '🗜️', '.tar': '🗜️', '.gz': '🗜️', '.7z': '🗜️',
    '.pdf': '📕', '.txt': '📃', '.gitignore': '🚫', '.lock': '🔒'
};

/**
 * In-memory ID Registry for file and folder paths to guarantee Telegram callback_data
 * stays strictly below 64 bytes regardless of folder nesting depth or file name length.
 */
class PathIdRegistry {
    private idToPath = new Map<string, string>();
    private pathToId = new Map<string, string>();
    private counter = 0;

    public register(fullPath: string): string {
        const norm = path.normalize(fullPath);
        const existing = this.pathToId.get(norm);
        if (existing) {
            return existing;
        }

        this.counter++;
        const id = this.counter.toString(36);
        this.idToPath.set(id, norm);
        this.pathToId.set(norm, id);

        // Keep registry bounded to avoid memory buildup in long-running sessions
        if (this.idToPath.size > 2000) {
            const firstKey = this.idToPath.keys().next().value;
            if (firstKey) {
                const p = this.idToPath.get(firstKey);
                this.idToPath.delete(firstKey);
                if (p) {
                    this.pathToId.delete(p);
                }
            }
        }
        return id;
    }

    public resolve(id: string): string | undefined {
        return this.idToPath.get(id);
    }
}

export const pathRegistry = new PathIdRegistry();

/**
 * Retrieves the root path of the first open workspace folder.
 */
export function getWorkspaceRoot(): string | null {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
        return null;
    }
    return path.normalize(folders[0].uri.fsPath);
}

/**
 * Lists the directory entries (folders and files) within the given path,
 * enforcing workspace boundary security.
 */
export function listDirectory(dirPath: string, workspaceRoot: string): FileEntry[] | null {
    const resolvedPath = path.resolve(dirPath);
    const resolvedRoot = path.resolve(workspaceRoot);

    // Security check: Must reside within the workspace
    if (!resolvedPath.toLowerCase().startsWith(resolvedRoot.toLowerCase())) {
        return null;
    }

    try {
        if (!fs.existsSync(resolvedPath)) {
            return null;
        }
        const stat = fs.statSync(resolvedPath);
        if (!stat.isDirectory()) {
            return null;
        }

        const entries = fs.readdirSync(resolvedPath, { withFileTypes: true });
        const result: FileEntry[] = [];

        for (const entry of entries) {
            if (IGNORED_NAMES.has(entry.name)) {
                continue;
            }
            if (entry.name.startsWith('.') && entry.isDirectory()) {
                continue;
            }

            const fullPath = path.join(resolvedPath, entry.name);
            const isDirectory = entry.isDirectory();
            let size: number | undefined;

            if (!isDirectory) {
                try {
                    size = fs.statSync(fullPath).size;
                } catch (_) {}
            }

            result.push({
                name: entry.name,
                fullPath,
                isDirectory,
                size,
                extension: isDirectory ? undefined : path.extname(entry.name).toLowerCase()
            });
        }

        // Sort: directories first, then alphabetically
        result.sort((a, b) => {
            if (a.isDirectory && !b.isDirectory) return -1;
            if (!a.isDirectory && b.isDirectory) return 1;
            return a.name.localeCompare(b.name);
        });

        return result;
    } catch (_) {
        return null;
    }
}

/**
 * Returns a suitable emoji icon for a file or directory.
 */
export function getFileIcon(entry: { isDirectory: boolean; extension?: string; name?: string }): string {
    if (entry.isDirectory) {
        return '📁';
    }
    const ext = entry.extension || (entry.name ? path.extname(entry.name).toLowerCase() : '');
    return FILE_ICONS[ext] ?? '📄';
}

/**
 * Formats byte size into human-readable representation.
 */
export function formatFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Finds a file in the workspace by name or relative path using vscode.workspace.findFiles.
 */
export async function findFileInWorkspace(fileName: string, root: string): Promise<string | null> {
    try {
        const cleanName = path.basename(fileName);
        const results = await vscode.workspace.findFiles(`**/${cleanName}`, '**/node_modules/**', 5);
        if (results && results.length > 0) {
            return path.normalize(results[0].fsPath);
        }
    } catch (_) {}
    return null;
}

/**
 * Builds the interactive Telegram inline keyboard for directory navigation and file download.
 */
export function buildFileBrowserKeyboard(
    entries: FileEntry[],
    currentPath: string,
    workspaceRoot: string,
    isAr: boolean = false
): any[][] {
    const rows: any[][] = [];
    const truncate = (s: string, max: number) => (s.length > max ? s.substring(0, max - 3) + '...' : s);

    // 1. Folders: up to 8, 2 per row
    const dirs = entries.filter(e => e.isDirectory).slice(0, 8);
    for (let i = 0; i < dirs.length; i += 2) {
        const slice = dirs.slice(i, i + 2);
        rows.push(
            slice.map(dir => {
                const dirId = pathRegistry.register(dir.fullPath);
                return {
                    text: `📁 ${truncate(dir.name, 18)}`,
                    callback_data: `bf:${dirId}`
                };
            })
        );
    }

    // 2. Files: up to 6, 2 per row
    const files = entries.filter(e => !e.isDirectory).slice(0, 6);
    for (let i = 0; i < files.length; i += 2) {
        const slice = files.slice(i, i + 2);
        rows.push(
            slice.map(file => {
                const fileId = pathRegistry.register(file.fullPath);
                const icon = getFileIcon(file);
                return {
                    text: `${icon} ${truncate(file.name, 16)}`,
                    callback_data: `df:${fileId}`
                };
            })
        );
    }

    // 3. Navigation Controls: Up, Root, Refresh
    const navRow: any[] = [];
    const normCurrent = path.normalize(currentPath).toLowerCase();
    const normRoot = path.normalize(workspaceRoot).toLowerCase();

    if (normCurrent !== normRoot) {
        const parentPath = path.dirname(currentPath);
        const parentId = pathRegistry.register(parentPath);
        navRow.push({
            text: isAr ? '⬆️ أعلى' : '⬆️ Up',
            callback_data: `bf:${parentId}`
        });
    }

    const rootId = pathRegistry.register(workspaceRoot);
    navRow.push({
        text: isAr ? '🏠 الجذر' : '🏠 Root',
        callback_data: `bf:${rootId}`
    });

    const currentId = pathRegistry.register(currentPath);
    navRow.push({
        text: isAr ? '🔄 تحديث' : '🔄 Refresh',
        callback_data: `rf:${currentId}`
    });

    rows.push(navRow);

    return rows;
}
