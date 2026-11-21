import * as os from 'os';
import * as cp from 'child_process';

/**
 * Execute a shell command asynchronously and return its output and status
 * @param command Command string to be executed by system shell
 */
export function executeShellCommand(command: string): Promise<{ stdout: string; stderr: string; code: number }> {
    return new Promise((resolve) => {
        // Execute command using child_process.exec with hidden window on Windows
        cp.exec(command, { windowsHide: true }, (error, stdout, stderr) => {
            // Check if process encountered an execution error
            if (error) {
                // Resolve with error code and stderr details
                resolve({
                    stdout: stdout ? stdout.toString() : '',
                    stderr: stderr ? stderr.toString() : error.message,
                    code: error.code !== undefined ? error.code : 1
                });
            } else {
                // Resolve with success status and stdout
                resolve({
                    stdout: stdout ? stdout.toString() : '',
                    stderr: stderr ? stderr.toString() : '',
                    code: 0
                });
            }
        });
    });
}

/**
 * Shut down the system with optional countdown delay in seconds
 * @param delaySeconds Seconds before shutdown starts (0 for immediate)
 */
export async function shutdownSystem(delaySeconds: number = 0): Promise<{ success: boolean; message?: string }> {
    // Determine the current operating system platform
    const platform = os.platform();
    // Sanitize non-negative delay value
    const delay = Math.max(0, Math.floor(delaySeconds));

    try {
        // Handle Windows platform
        if (platform === 'win32') {
            // Execute Windows native shutdown command with timeout flag
            const res = await executeShellCommand(`shutdown /s /t ${delay}`);
            // Check if command completed successfully
            return { success: res.code === 0, message: res.stderr || res.stdout };
        } else if (platform === 'darwin') {
            // Handle macOS platform using AppleScript or shutdown
            if (delay === 0) {
                // Immediate shutdown via AppleScript System Events
                const res = await executeShellCommand(`osascript -e 'tell app "System Events" to shut down'`);
                return { success: res.code === 0, message: res.stderr || res.stdout };
            } else {
                // Scheduled shutdown in minutes
                const minutes = Math.max(1, Math.ceil(delay / 60));
                const res = await executeShellCommand(`sudo shutdown -h +${minutes}`);
                return { success: res.code === 0, message: res.stderr || res.stdout };
            }
        } else {
            // Handle Linux platform via shutdown command
            if (delay === 0) {
                // Immediate shutdown
                const res = await executeShellCommand(`shutdown -h now`);
                return { success: res.code === 0, message: res.stderr || res.stdout };
            } else {
                // Scheduled shutdown in minutes
                const minutes = Math.max(1, Math.ceil(delay / 60));
                const res = await executeShellCommand(`shutdown -h +${minutes}`);
                return { success: res.code === 0, message: res.stderr || res.stdout };
            }
        }
    } catch (err: any) {
        // Return failure message if command throwing an exception
        return { success: false, message: err?.message || 'Failed to execute shutdown' };
    }
}

/**
 * Restart the system with optional countdown delay in seconds
 * @param delaySeconds Seconds before restart starts (0 for immediate)
 */
export async function restartSystem(delaySeconds: number = 0): Promise<{ success: boolean; message?: string }> {
    // Determine current operating system platform
    const platform = os.platform();
    // Sanitize non-negative delay value
    const delay = Math.max(0, Math.floor(delaySeconds));

    try {
        // Handle Windows platform
        if (platform === 'win32') {
            // Execute Windows native restart command
            const res = await executeShellCommand(`shutdown /r /t ${delay}`);
            // Check if command succeeded
            return { success: res.code === 0, message: res.stderr || res.stdout };
        } else if (platform === 'darwin') {
            // Handle macOS platform
            if (delay === 0) {
                // Immediate restart via AppleScript
                const res = await executeShellCommand(`osascript -e 'tell app "System Events" to restart'`);
                return { success: res.code === 0, message: res.stderr || res.stdout };
            } else {
                // Scheduled restart in minutes
                const minutes = Math.max(1, Math.ceil(delay / 60));
                const res = await executeShellCommand(`sudo shutdown -r +${minutes}`);
                return { success: res.code === 0, message: res.stderr || res.stdout };
            }
        } else {
            // Handle Linux platform
            if (delay === 0) {
                // Immediate reboot
                const res = await executeShellCommand(`shutdown -r now`);
                return { success: res.code === 0, message: res.stderr || res.stdout };
            } else {
                // Scheduled reboot
                const minutes = Math.max(1, Math.ceil(delay / 60));
                const res = await executeShellCommand(`shutdown -r +${minutes}`);
                return { success: res.code === 0, message: res.stderr || res.stdout };
            }
        }
    } catch (err: any) {
        // Return failure message on exception
        return { success: false, message: err?.message || 'Failed to execute restart' };
    }
}

/**
 * Suspend/sleep the system
 */
export async function sleepSystem(): Promise<{ success: boolean; message?: string }> {
    // Determine the host platform
    const platform = os.platform();

    try {
        // Handle Windows platform
        if (platform === 'win32') {
            // Attempt to trigger sleep via PowerShell calling .NET SetSuspendState without hibernation
            const psCmd = `powershell -NoProfile -NonInteractive -Command "[System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms') | Out-Null; [System.Windows.Forms.Application]::SetSuspendState([System.Windows.Forms.PowerState]::Suspend, $false, $false)"`;
            const res = await executeShellCommand(psCmd);
            // If PowerShell invocation returned non-zero, fallback to rundll32
            if (res.code !== 0) {
                // Fallback command via powrprof.dll
                const fallbackRes = await executeShellCommand(`rundll32.exe powrprof.dll,SetSuspendState 0,1,0`);
                return { success: fallbackRes.code === 0, message: fallbackRes.stderr || fallbackRes.stdout };
            }
            return { success: true };
        } else if (platform === 'darwin') {
            // Handle macOS platform using pmset sleepnow
            const res = await executeShellCommand(`pmset sleepnow`);
            return { success: res.code === 0, message: res.stderr || res.stdout };
        } else {
            // Handle Linux platform using systemctl suspend
            const res = await executeShellCommand(`systemctl suspend`);
            return { success: res.code === 0, message: res.stderr || res.stdout };
        }
    } catch (err: any) {
        // Return failure message on exception
        return { success: false, message: err?.message || 'Failed to trigger sleep' };
    }
}

/**
 * Lock the computer workstation screen
 */
export async function lockWorkstation(): Promise<{ success: boolean; message?: string }> {
    // Determine the host platform
    const platform = os.platform();

    try {
        // Handle Windows platform
        if (platform === 'win32') {
            // Lock workstation via user32.dll export
            const res = await executeShellCommand(`rundll32.exe user32.dll,LockWorkStation`);
            return { success: res.code === 0, message: res.stderr || res.stdout };
        } else if (platform === 'darwin') {
            // Handle macOS platform
            const res = await executeShellCommand(`pmset displaysleepnow`);
            return { success: res.code === 0, message: res.stderr || res.stdout };
        } else {
            // Handle Linux platform
            const res = await executeShellCommand(`loginctl lock-session || xdg-screensaver lock`);
            return { success: res.code === 0, message: res.stderr || res.stdout };
        }
    } catch (err: any) {
        // Return failure message on exception
        return { success: false, message: err?.message || 'Failed to lock workstation' };
    }
}

/**
 * Abort/cancel an existing scheduled shutdown or restart
 */
export async function abortShutdown(): Promise<{ success: boolean; alreadyAborted?: boolean; message?: string }> {
    // Determine the host platform
    const platform = os.platform();

    try {
        // Handle Windows platform
        if (platform === 'win32') {
            // Execute Windows shutdown /a
            const res = await executeShellCommand(`shutdown /a`);
            // Check if Windows reports that no shutdown was in progress (error code 1116)
            if (res.code !== 0 && (res.stderr.includes('1116') || res.stderr.toLowerCase().includes('no shutdown was in progress'))) {
                return { success: true, alreadyAborted: true, message: 'No shutdown in progress' };
            }
            return { success: res.code === 0, message: res.stderr || res.stdout };
        } else if (platform === 'darwin') {
            // Handle macOS platform
            const res = await executeShellCommand(`sudo killall shutdown`);
            return { success: res.code === 0, message: res.stderr || res.stdout };
        } else {
            // Handle Linux platform
            const res = await executeShellCommand(`shutdown -c`);
            return { success: res.code === 0, message: res.stderr || res.stdout };
        }
    } catch (err: any) {
        // Return failure message on exception
        return { success: false, message: err?.message || 'Failed to cancel shutdown' };
    }
}

/**
 * Retrieve formatted system information including hardware, RAM, CPU, and Uptime
 */
export function getSystemInfo(): string {
    // Extract hostname
    const hostname = os.hostname();
    // Extract platform and architecture
    const platform = os.platform();
    const type = os.type();
    const release = os.release();
    const arch = os.arch();

    // Format uptime into days, hours, and minutes
    const uptimeSec = os.uptime();
    const days = Math.floor(uptimeSec / 86400);
    const hours = Math.floor((uptimeSec % 86400) / 3600);
    const minutes = Math.floor((uptimeSec % 3600) / 60);
    const uptimeFormatted = `${days > 0 ? `${days}d ` : ''}${hours}h ${minutes}m`;

    // Compute memory usage in gigabytes
    const totalMemBytes = os.totalmem();
    const freeMemBytes = os.freemem();
    const usedMemBytes = totalMemBytes - freeMemBytes;
    const totalMemGb = (totalMemBytes / (1024 ** 3)).toFixed(2);
    const usedMemGb = (usedMemBytes / (1024 ** 3)).toFixed(2);
    const memUsagePct = ((usedMemBytes / totalMemBytes) * 100).toFixed(1);

    // Retrieve CPU information
    const cpus = os.cpus();
    const cpuModel = cpus && cpus.length > 0 ? cpus[0].model.trim() : 'Unknown';
    const cpuCores = cpus ? cpus.length : 0;

    // Retrieve active local IPv4 addresses
    const networkInterfaces = os.networkInterfaces();
    const ipAddresses: string[] = [];
    // Iterate network interfaces
    for (const ifaceName of Object.keys(networkInterfaces)) {
        const ifaceList = networkInterfaces[ifaceName];
        if (ifaceList) {
            for (const addr of ifaceList) {
                // Filter for external IPv4 addresses
                if (addr.family === 'IPv4' && !addr.internal) {
                    ipAddresses.push(`${addr.address} (${ifaceName})`);
                }
            }
        }
    }

    // Build formatted Markdown report
    let report = `💻 *System Information*\n\n`;
    report += `🏷️ *Host:* \`${hostname}\`\n`;
    report += `🖥️ *OS:* ${type} ${release} (${platform} ${arch})\n`;
    report += `⏱️ *Uptime:* ${uptimeFormatted}\n\n`;
    report += `🧠 *Memory (RAM):*\n`;
    report += `  • Used: *${usedMemGb} GB* / ${totalMemGb} GB (*${memUsagePct}%*)\n\n`;
    report += `⚡ *Processor (CPU):*\n`;
    report += `  • Model: ${cpuModel}\n`;
    report += `  • Cores: *${cpuCores}* logical cores\n\n`;
    if (ipAddresses.length > 0) {
        report += `🌐 *Network IP:*\n`;
        for (const ip of ipAddresses) {
            report += `  • \`${ip}\`\n`;
        }
    }

    return report;
}

export interface SystemTelemetry {
    hostname: string;
    platform: string;
    type: string;
    release: string;
    arch: string;
    uptimeFormatted: string;
    uptimeSec: number;
    totalMemBytes: number;
    freeMemBytes: number;
    usedMemBytes: number;
    totalMemGb: number;
    usedMemGb: number;
    freeMemGb: number;
    memUsagePct: number;
    cpuModel: string;
    cpuCores: number;
    ipAddresses: string[];
}

/**
 * Retrieve structured system telemetry and metrics
 */
export function getSystemTelemetry(): SystemTelemetry {
    const hostname = os.hostname();
    const platform = os.platform();
    const type = os.type();
    const release = os.release();
    const arch = os.arch();

    const uptimeSec = os.uptime();
    const days = Math.floor(uptimeSec / 86400);
    const hours = Math.floor((uptimeSec % 86400) / 3600);
    const minutes = Math.floor((uptimeSec % 3600) / 60);
    const uptimeFormatted = `${days > 0 ? `${days}d ` : ''}${hours}h ${minutes}m`;

    const totalMemBytes = os.totalmem();
    const freeMemBytes = os.freemem();
    const usedMemBytes = totalMemBytes - freeMemBytes;
    const totalMemGb = parseFloat((totalMemBytes / (1024 ** 3)).toFixed(2));
    const usedMemGb = parseFloat((usedMemBytes / (1024 ** 3)).toFixed(2));
    const freeMemGb = parseFloat((freeMemBytes / (1024 ** 3)).toFixed(2));
    const memUsagePct = parseFloat(((usedMemBytes / totalMemBytes) * 100).toFixed(1));

    const cpus = os.cpus();
    const cpuModel = cpus && cpus.length > 0 ? cpus[0].model.trim() : 'Unknown';
    const cpuCores = cpus ? cpus.length : 0;

    const networkInterfaces = os.networkInterfaces();
    const ipAddresses: string[] = [];
    for (const ifaceName of Object.keys(networkInterfaces)) {
        const ifaceList = networkInterfaces[ifaceName];
        if (ifaceList) {
            for (const addr of ifaceList) {
                if (addr.family === 'IPv4' && !addr.internal) {
                    ipAddresses.push(`${addr.address} (${ifaceName})`);
                }
            }
        }
    }

    return {
        hostname,
        platform,
        type,
        release,
        arch,
        uptimeFormatted,
        uptimeSec,
        totalMemBytes,
        freeMemBytes,
        usedMemBytes,
        totalMemGb,
        usedMemGb,
        freeMemGb,
        memUsagePct,
        cpuModel,
        cpuCores,
        ipAddresses
    };
}
