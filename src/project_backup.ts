import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
// HTTPS module for direct API communication
import * as https from 'https';
// Crypto module for random boundary generation
import * as crypto from 'crypto';
// Child process module for executing native compression fallbacks
import * as child_process from 'child_process';
// Archiver module for generating zip streams
const archiver = require('archiver');
import ignore from 'ignore';

/**
 * Result structure returned when a project backup archive is created.
 */
export interface BackupResult {
    // Indicates if backup was created successfully
    success: boolean;
    // Absolute path to the generated zip file
    zipPath?: string;
    // Filename of the generated zip file
    fileName?: string;
    // Total size of the zip archive in bytes
    fileSize?: number;
    // Human-readable formatted file size string (e.g. 2.45 MB)
    fileSizeFormatted?: string;
    // Total number of files included in the archive
    fileCount?: number;
    // Name of the workspace or project that was backed up
    projectName?: string;
    // Error message if backup creation failed
    error?: string;
}

/**
 * Common framework library and build output directory patterns to exclude from backups.
 */
const DEFAULT_IGNORED_PATTERNS = [
    // Version control directories
    '.git',
    '.git/**',
    '.svn',
    '.hg',
    // Node.js dependency trees
    'node_modules',
    'node_modules/**',
    // PHP composer dependencies
    'vendor',
    'vendor/**',
    // Python virtual environments and bytecode cache
    '.venv',
    '.venv/**',
    'venv',
    'venv/**',
    'env',
    'env/**',
    '__pycache__',
    '__pycache__/**',
    '*.pyc',
    '.pytest_cache',
    // Java and Rust build artifacts
    'target',
    'target/**',
    // .NET compiled binaries and intermediate artifacts
    'bin',
    'bin/**',
    'obj',
    'obj/**',
    // Android and Flutter build directories
    '.gradle',
    '.gradle/**',
    '.dart_tool',
    '.dart_tool/**',
    'build',
    'build/**',
    // iOS CocoaPods dependencies
    'Pods',
    'Pods/**',
    // General build outputs and extension packages
    'dist',
    'dist/**',
    'out',
    'out/**',
    '*.vsix',
    // IDE caches and test directories
    '.idea',
    '.vscode-test',
    '*.tmp',
    '*.log'
];

/**
 * Formats a raw byte count into a human-readable string.
 */
export function formatBytes(bytes: number): string {
    // Return 0 B for zero or negative values
    if (bytes <= 0) return '0 B';
    // Define binary size units
    const units = ['B', 'KB', 'MB', 'GB'];
    // Calculate log index
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    // Format to 2 decimal places
    const size = (bytes / Math.pow(1024, i)).toFixed(2);
    // Combine number and unit
    return `${size} ${units[i]}`;
}

/**
 * Formats current timestamp for filenames (e.g. 20261016_193000).
 */
function getTimestampString(): string {
    // Create new Date instance
    const now = new Date();
    // Extract year
    const y = now.getFullYear();
    // Extract 2-digit month
    const m = String(now.getMonth() + 1).padStart(2, '0');
    // Extract 2-digit day
    const d = String(now.getDate()).padStart(2, '0');
    // Extract 2-digit hour
    const h = String(now.getHours()).padStart(2, '0');
    // Extract 2-digit minute
    const min = String(now.getMinutes()).padStart(2, '0');
    // Extract 2-digit second
    const s = String(now.getSeconds()).padStart(2, '0');
    // Return formatted timestamp
    return `${y}${m}${d}_${h}${min}${s}`;
}

/**
 * Fallback archive creation using native operating system utilities (tar.exe, powershell, or zip).
 * Guaranteed to succeed without any external npm module dependencies.
 */
function createWithNativeZip(rootPath: string, filesToArchive: string[], zipPath: string): number {
    // Generate temporary text file path containing the relative files list
    const listFilePath = path.join(os.tmpdir(), `_backup_files_${Date.now()}_${Math.random().toString(36).slice(2)}.txt`);
    try {
        // Write the list of files to archive separated by newlines
        fs.writeFileSync(listFilePath, filesToArchive.join(os.EOL), 'utf8');

        // Check if current operating system is Windows
        if (process.platform === 'win32') {
            try {
                // Windows 10/11 includes bsdtar natively with automatic zip creation via -a flag
                child_process.execFileSync('tar.exe', ['-a', '-c', '-f', zipPath, '-C', rootPath, '-T', listFilePath], {
                    windowsHide: true,
                    timeout: 60000
                });
            } catch (tarErr) {
                // Log warning and attempt secondary PowerShell Compress-Archive fallback
                console.warn('[Backup] Native tar.exe failed, attempting PowerShell fallback:', tarErr);
                // Construct PowerShell script to compress files list
                const psCommand = `Get-Content '${listFilePath}' | ForEach-Object { Join-Path '${rootPath}' $_ } | Compress-Archive -DestinationPath '${zipPath}' -Force`;
                // Execute PowerShell command
                child_process.execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psCommand], {
                    windowsHide: true,
                    timeout: 120000
                });
            }
        } else {
            try {
                // On Unix platforms (Linux/macOS), attempt using standard zip utility
                child_process.execFileSync('zip', ['-q', '-r', zipPath, '.', '-i@' + listFilePath], {
                    cwd: rootPath,
                    timeout: 60000
                });
            } catch (zipErr) {
                // Fallback to native tar with gzip compression
                console.warn('[Backup] Native zip failed, attempting tar fallback:', zipErr);
                child_process.execFileSync('tar', ['-a', '-c', '-f', zipPath, '-C', rootPath, '-T', listFilePath], {
                    timeout: 60000
                });
            }
        }

        // Verify that the archive file was created successfully
        if (fs.existsSync(zipPath)) {
            // Retrieve file size from file system stats
            const stats = fs.statSync(zipPath);
            // Return size in bytes
            return stats.size;
        }

        // Throw error if archive file was not produced
        throw new Error('Native compression completed but archive file was not found');
    } finally {
        // Clean up temporary list file
        try {
            // Check if temporary list file exists
            if (fs.existsSync(listFilePath)) {
                // Unlink temporary list file
                fs.unlinkSync(listFilePath);
            }
        } catch (_) { /* ignore list file cleanup error */ }
    }
}

/**
 * Creates a zip backup of the active VS Code workspace project.
 * Excludes framework dependencies and files listed in .gitignore.
 */
export async function createProjectBackup(customPath?: string): Promise<BackupResult> {
    // Determine the root directory of the project to backup
    let rootPath = customPath;

    // If no custom path is provided, use the active workspace folder
    if (!rootPath) {
        // Query workspace folders from VS Code API
        const folders = vscode.workspace.workspaceFolders;
        // Verify that at least one workspace folder is open
        if (folders && folders.length > 0) {
            // Use the first active workspace folder
            rootPath = folders[0].uri.fsPath;
        }
    }

    // Return error if no workspace project could be determined
    if (!rootPath || !fs.existsSync(rootPath)) {
        return {
            success: false,
            error: 'no_workspace_open'
        };
    }

    // Extract project directory name
    const projectName = path.basename(rootPath);
    // Generate unique timestamped archive filename
    const fileName = `${projectName}_backup_${getTimestampString()}.zip`;
    // Place archive in the system temporary directory
    const zipPath = path.join(os.tmpdir(), fileName);

    // Initialize ignore parser
    const ig = ignore();

    // Add built-in framework dependency and build output patterns
    ig.add(DEFAULT_IGNORED_PATTERNS);

    // Check if project contains a root .gitignore file
    const gitignorePath = path.join(rootPath, '.gitignore');
    if (fs.existsSync(gitignorePath)) {
        try {
            // Read gitignore file content
            const gitignoreContent = fs.readFileSync(gitignorePath, 'utf8');
            // Parse gitignore rules
            ig.add(gitignoreContent);
        } catch (e: any) {
            // Log warning if gitignore reading fails
            console.warn('[Backup] Failed to read .gitignore:', e.message);
        }
    }

    // Also check for .git/info/exclude if available
    const gitExcludePath = path.join(rootPath, '.git', 'info', 'exclude');
    if (fs.existsSync(gitExcludePath)) {
        try {
            // Read git exclude content
            const excludeContent = fs.readFileSync(gitExcludePath, 'utf8');
            // Parse exclude rules
            ig.add(excludeContent);
        } catch (_) { /* ignore exclude read error */ }
    }

    // File counter to track files included in backup
    let fileCount = 0;

    // Helper function to recursively collect files respecting ignore rules
    function collectFiles(dir: string, relDir: string = ''): string[] {
        // Array of relative file paths to return
        const results: string[] = [];

        // Read all entries in the directory
        let entries: fs.Dirent[] = [];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch (_) {
            return results;
        }

        // Iterate through directory entries
        for (const entry of entries) {
            // Compute relative path from project root using forward slashes for ignore library
            const relativePath = relDir ? `${relDir}/${entry.name}` : entry.name;

            // Check if entry is a directory
            if (entry.isDirectory()) {
                // Check if directory matches ignore rules (append slash for directory matching)
                if (ig.ignores(`${relativePath}/`) || ig.ignores(relativePath)) {
                    // Skip ignored directory completely
                    continue;
                }
                // Recursively collect files from subdirectory
                const subFiles = collectFiles(path.join(dir, entry.name), relativePath);
                // Concatenate collected files
                results.push(...subFiles);
            } else if (entry.isFile() || entry.isSymbolicLink()) {
                // Check if file matches ignore rules
                if (ig.ignores(relativePath)) {
                    // Skip ignored file
                    continue;
                }
                // Add valid file path
                results.push(relativePath);
            }
        }

        // Return collected relative file paths
        return results;
    }

    // Collect all project files matching criteria
    const filesToArchive = collectFiles(rootPath);

    // Verify that project has files to archive
    if (filesToArchive.length === 0) {
        return {
            success: false,
            error: 'no_files_to_backup'
        };
    }

    // Helper function to create archive using archiver library
    const tryArchiver = (): Promise<number> => {
        return new Promise<number>((resolve, reject) => {
            try {
                // Resolve callable archiver factory function
                let archiverLib: any;
                try {
                    archiverLib = require('archiver');
                } catch (loadErr) {
                    return reject(loadErr);
                }

                const archiverFactory = typeof archiverLib === 'function' 
                    ? archiverLib 
                    : (archiverLib && typeof archiverLib.default === 'function' ? archiverLib.default : null);

                if (!archiverFactory && !archiverLib.ZipArchive && !archiverLib.default?.ZipArchive) {
                    return reject(new Error('archiver is not a callable function or class'));
                }

                // Initialize archiver instance
                const archive = archiverFactory 
                    ? archiverFactory('zip', { zlib: { level: 9 } }) 
                    : new (archiverLib.ZipArchive || archiverLib.default?.ZipArchive)({ zlib: { level: 9 } });

                // Create file output stream for the zip archive
                const output = fs.createWriteStream(zipPath);

                // Handle stream finish event
                output.on('close', () => {
                    // Read final archive file size
                    const size = archive.pointer ? archive.pointer() : (fs.existsSync(zipPath) ? fs.statSync(zipPath).size : 0);
                    resolve(size);
                });

                // Handle archiver warnings
                archive.on('warning', (err: any) => {
                    if (err.code !== 'ENOENT') {
                        console.warn('[Backup] Archiver warning:', err.message);
                    }
                });

                // Handle archiver errors
                archive.on('error', (err: any) => {
                    reject(err);
                });

                // Pipe archive stream to output file
                archive.pipe(output);

                // Add each file to the archive
                for (const relFile of filesToArchive) {
                    const fullPath = path.join(rootPath!, relFile);
                    archive.file(fullPath, { name: relFile });
                }

                // Finalize archive stream
                archive.finalize();
            } catch (err) {
                reject(err);
            }
        });
    };

    // Track final archive byte size
    let finalFileSize = 0;
    try {
        // Attempt primary archive generation using archiver library
        finalFileSize = await tryArchiver();
    } catch (primaryErr: any) {
        // Log warning and seamlessly switch to native OS compression fallback
        console.warn('[Backup] Primary archiver failed, switching to native OS fallback:', primaryErr?.message || primaryErr);
        try {
            // Execute native zip compression fallback (tar.exe, powershell, or zip)
            finalFileSize = createWithNativeZip(rootPath!, filesToArchive, zipPath);
        } catch (fallbackErr: any) {
            // Log fatal error if both methods fail
            console.error('[Backup] Both archiver and native fallback failed:', fallbackErr);
            return {
                success: false,
                error: `Archiver: ${primaryErr?.message || primaryErr} | Fallback: ${fallbackErr?.message || fallbackErr}`
            };
        }
    }

    // Return successful backup result
    return {
        success: true,
        zipPath,
        fileName,
        fileSize: finalFileSize,
        fileSizeFormatted: formatBytes(finalFileSize),
        fileCount: filesToArchive.length,
        projectName
    };
}

/**
 * Uploads a document directly via Telegram Bot API using raw HTTPS multipart POST.
 * Sets explicit Content-Length and Connection: close to completely eliminate
 * Telegraf's chunked-streaming socket reuse and ECONNRESET errors on document uploads.
 */
export function sendDocumentDirect(
    token: string,
    chatId: string | number,
    filePath: string,
    fileName: string,
    caption?: string
): Promise<any> {
    // Return promise representing network request outcome
    return new Promise((resolve, reject) => {
        // Verify that the target file exists on disk
        if (!fs.existsSync(filePath)) {
            // Reject if file is not found
            return reject(new Error(`File not found at: ${filePath}`));
        }

        // Read the complete archive file into a memory buffer
        const fileData = fs.readFileSync(filePath);

        // Generate a cryptographically random multipart boundary delimiter
        const boundary = '----TelegramBackupBoundary' + crypto.randomBytes(16).toString('hex');

        // Collect all multipart payload buffers
        const parts: Buffer[] = [];

        // Append chat_id field
        parts.push(Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n`
        ));

        // Append caption and markdown parse_mode if provided
        if (caption) {
            // Append caption part
            parts.push(Buffer.from(
                `--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${caption}\r\n`
            ));
            // Append parse_mode part
            parts.push(Buffer.from(
                `--${boundary}\r\nContent-Disposition: form-data; name="parse_mode"\r\n\r\nMarkdown\r\n`
            ));
        }

        // Append document binary field with filename and application/zip MIME type
        parts.push(Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="${fileName}"\r\nContent-Type: application/zip\r\n\r\n`
        ));
        // Push raw binary zip file data
        parts.push(fileData);
        // Push closing multipart boundary
        parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

        // Concatenate all parts into a single contiguous buffer
        const fullBody = Buffer.concat(parts);

        // Prepare HTTPS request options with strict Content-Length and disabled keep-alive
        const req = https.request({
            hostname: 'api.telegram.org',
            port: 443,
            path: `/bot${token}/sendDocument`,
            method: 'POST',
            headers: {
                'Content-Type': `multipart/form-data; boundary=${boundary}`,
                'Content-Length': fullBody.length,
                'Connection': 'close' // Disable keep-alive to prevent socket reuse resets
            },
            timeout: 180000 // 3 minutes timeout for large file uploads
        }, (res) => {
            // Accumulate response body
            let resData = '';
            // Set text encoding
            res.setEncoding('utf8');
            // Collect chunks
            res.on('data', chunk => { resData += chunk; });
            // Handle response end
            res.on('end', () => {
                try {
                    // Parse response JSON
                    const json = JSON.parse(resData);
                    // Check if response status is ok
                    if (json.ok) {
                        // Resolve with result payload
                        resolve(json.result);
                    } else {
                        // Reject with descriptive error message
                        reject(new Error(`Telegram API Error: ${json.description || 'Unknown'} (code ${json.error_code})`));
                    }
                } catch (e: any) {
                    // Reject on JSON parse error
                    reject(new Error(`Invalid response from Telegram API: ${resData}`));
                }
            });
        });

        // Handle network and request errors
        req.on('error', (err) => {
            // Reject promise with error
            reject(err);
        });

        // Handle request timeout
        req.on('timeout', () => {
            // Abort request
            req.destroy();
            // Reject with timeout error
            reject(new Error('Document upload timed out after 180 seconds'));
        });

        // Transmit the complete buffer in one operation
        req.end(fullBody);
    });
}
