'use strict';
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// Inspect executable locations directly: minimal server/Termux environments may
// not contain where.exe/which, or may retain PATH from before CLI installation.
async function findCodex({ env = process.env, platform = process.platform, executable = process.execPath, home = os.homedir() } = {}) {
    const windows = platform === 'win32';
    const paths = windows ? path.win32 : path.posix;
    const pathKey = windows ? Object.keys(env).find(key => key.toLowerCase() === 'path') : 'PATH';
    const clean = value => String(value || '').trim().replace(/^"(.*)"$/, '$1');
    const directories = String(env[pathKey] || '').split(windows ? ';' : ':').map(clean).filter(Boolean);
    // npm installs beside node on Unix; user-global npm on Windows uses APPDATA.
    directories.push(paths.dirname(executable));
    if (windows) {
        if (env.APPDATA) directories.push(paths.join(env.APPDATA, 'npm'));
        if (env.LOCALAPPDATA) directories.push(paths.join(env.LOCALAPPDATA, 'Programs', 'OpenAI', 'Codex', 'bin'));
        if (home) directories.push(paths.join(home, 'AppData', 'Roaming', 'npm'), paths.join(home, '.local', 'bin'));
    } else {
        if (env.PREFIX) directories.push(paths.join(env.PREFIX, 'bin'));
        if (home) directories.push(paths.join(home, '.local', 'bin'), paths.join(home, '.npm-global', 'bin'));
        directories.push('/opt/homebrew/bin', '/usr/local/bin', '/usr/bin');
    }
    const names = windows ? ['codex.exe', 'codex.cmd', 'codex.bat'] : ['codex'];
    const visited = new Set();
    for (const directory of directories) {
        // Ignore relative PATH entries; they can depend on a server's workspace.
        if (!paths.isAbsolute(directory)) continue;
        const key = windows ? directory.toLowerCase() : directory;
        if (visited.has(key)) continue;
        visited.add(key);
        for (const name of names) {
            const file = paths.join(directory, name);
            try {
                if (!(await fs.stat(file)).isFile()) continue;
                await fs.access(file, windows ? constants.F_OK : constants.X_OK);
                return file;
            } catch { /* Try the next PATH entry or known install location. */ }
        }
    }
    return null;
}

function cliInvocation(binary, args, { platform = process.platform, executable = process.execPath } = {}) {
    const wrapper = platform === 'win32' && /\.(cmd|bat)$/i.test(binary);
    if (wrapper) {
        const entry = path.win32.join(path.win32.dirname(binary), 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
        // npm's wrapper calls `node` from PATH. Use the running server's Node
        // instead, retaining stdin and arguments even with a stale/empty PATH.
        if (require('node:fs').existsSync(entry)) return { command: executable, args: [entry, ...args], shell: false };
    }
    // Preserve explicitly configured, non-npm batch launchers.
    return { command: binary, args, shell: wrapper };
}

module.exports = { findCodex, cliInvocation };
