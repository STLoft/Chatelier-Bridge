'use strict';
const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function cliPackage(isTermux) {
    return isTermux ? '@mmmbuto/codex-cli-termux' : '@openai/codex';
}

function firstWindowsCommand(found) {
    // Respect PATH order: a later standalone executable must not shadow an earlier npm command.
    return found.find(file => /\.(exe|cmd|bat)$/i.test(file)) || found[0];
}

function unsupported() {
    const error = new Error('npm으로 설치된 Codex CLI를 확인할 수 없습니다. 현재 CLI를 설치한 방법으로 업데이트하세요.');
    error.code = 'UNSUPPORTED_INSTALL';
    return error;
}

async function resolveNpmInstallation(binary, globalRoot, packageName, platform = process.platform) {
    const packageRoot = path.join(globalRoot, ...packageName.split('/'));
    let metadata, realBinary;
    try {
        metadata = JSON.parse(await fs.readFile(path.join(packageRoot, 'package.json'), 'utf8'));
        realBinary = await fs.realpath(binary);
    } catch { throw unsupported(); }
    if (metadata.name !== packageName || !metadata.version) throw unsupported();
    const relative = path.relative(await fs.realpath(packageRoot), realBinary);
    const withinPackage = relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    if (!withinPackage) {
        if (platform !== 'win32' || path.dirname(realBinary).toLowerCase() !== path.dirname(globalRoot).toLowerCase()) throw unsupported();
        const wrapper = (await fs.readFile(realBinary, 'utf8')).replaceAll('\\', '/');
        if (!wrapper.includes(`/node_modules/${packageName}/`)) throw unsupported();
    }
    return { packageName, packageRoot, globalRoot, version: metadata.version, platform };
}

async function fingerprint(directory, prefix = '') {
    const result = {};
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const name = prefix + entry.name;
        const file = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) result[name] = { link: await fs.readlink(file) };
        else if (entry.isDirectory()) Object.assign(result, await fingerprint(file, `${name}/`));
        else if (entry.isFile()) {
            const hash = crypto.createHash('sha256');
            for await (const chunk of createReadStream(file)) hash.update(chunk);
            result[name] = hash.digest('hex');
        }
    }
    return result;
}

async function backupNpmInstallation(installation, backupRoot) {
    const name = `${installation.packageName.replace(/[^a-z0-9-]/gi, '_')}-${installation.version}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    const directory = path.join(backupRoot, name);
    await fs.mkdir(directory, { recursive: true });
    const before = await fingerprint(installation.packageRoot);
    const packageBackup = path.join(directory, 'package');
    await fs.cp(installation.packageRoot, packageBackup, { recursive: true, verbatimSymlinks: true });
    const after = await fingerprint(packageBackup);
    const stable = await fingerprint(installation.packageRoot);
    const same = value => JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
    if (same(before) !== same(after) || same(before) !== same(stable)) throw new Error('CLI 백업 검증에 실패해 업데이트하지 않았습니다.');
    if (installation.platform === 'win32') {
        const prefix = path.dirname(installation.globalRoot);
        for (const shim of ['codex', 'codex.cmd', 'codex.ps1']) {
            const source = path.join(prefix, shim);
            try { await fs.copyFile(source, path.join(directory, shim)); }
            catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
    }
    await fs.writeFile(path.join(directory, 'VERIFIED.json'), JSON.stringify({ ...installation, files: before }, null, 2));
    return directory;
}

module.exports = { cliPackage, firstWindowsCommand, resolveNpmInstallation, backupNpmInstallation };
