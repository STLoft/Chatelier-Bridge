'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { findCodex, cliInvocation } = require('../cli-resolver.cjs');

test('finds CLI without which/where; honors PATH before fallback installs', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex path '));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const first = path.join(root, 'npm bin'), later = path.join(root, 'standalone');
    await fs.mkdir(first); await fs.mkdir(later);
    const name = process.platform === 'win32' ? 'codex.cmd' : 'codex';
    await fs.writeFile(path.join(first, name), '#!/bin/sh\n', { mode: 0o755 });
    await fs.writeFile(path.join(later, process.platform === 'win32' ? 'codex.exe' : 'codex'), '', { mode: 0o755 });
    const env = { [process.platform === 'win32' ? 'Path' : 'PATH']: [first, later].join(path.delimiter) };
    assert.equal(await findCodex({ env, executable: path.join(root, 'node'), home: root }), path.join(first, name));
});

function fixture(platform, files) {
    const checked = [];
    const module = { exports: {} };
    const source = require('node:fs').readFileSync(require.resolve('../cli-resolver.cjs'), 'utf8');
    vm.runInNewContext(source, { module, process, require(name) {
        if (name === 'node:fs/promises') return {
            async stat(file) { checked.push(file); if (!files.includes(file)) throw new Error('ENOENT'); return { isFile: () => true }; },
            async access() {},
        };
        return require(name);
    } });
    return { find: options => module.exports.findCodex({ platform, ...options }), checked };
}

test('Windows stale PATH falls back to user npm install and handles quoted Path', async () => {
    const cli = 'C:\\Users\\Test User\\AppData\\Roaming\\npm\\codex.cmd';
    const f = fixture('win32', [cli]);
    assert.equal(await f.find({ env: { Path: '"C:\\Windows\\System32"', APPDATA: 'C:\\Users\\Test User\\AppData\\Roaming' }, executable: 'C:\\node\\node.exe', home: 'C:\\Users\\Test User' }), cli);
    assert.ok(f.checked.includes('C:\\Windows\\System32\\codex.exe'));
});

test('Termux stale PATH uses PREFIX/bin without requiring which', async () => {
    const cli = '/data/data/com.termux/files/usr/bin/codex';
    const f = fixture('android', [cli]);
    assert.equal(await f.find({ env: { PATH: '/missing', PREFIX: '/data/data/com.termux/files/usr' }, executable: '/custom/node', home: '/data/data/com.termux/files/home' }), cli);
});

test('Unix npm sibling and user-local installs work with empty PATH', async () => {
    for (const cli of ['/opt/node/bin/codex', '/home/test/.local/bin/codex']) {
        const f = fixture('linux', [cli]);
        assert.equal(await f.find({ env: {}, executable: '/opt/node/bin/node', home: '/home/test' }), cli);
    }
});

test('missing CLI returns null and relative PATH directories are ignored', async () => {
    const f = fixture('linux', []);
    assert.equal(await f.find({ env: { PATH: '.:relative/bin:/missing' }, executable: '/node/node', home: '/home/test' }), null);
    assert.ok(f.checked.every(file => file.startsWith('/')));
});

test('Windows npm wrapper runs through the server Node without using PATH', { skip: process.platform !== 'win32' }, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex npm wrapper '));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const entry = path.join(root, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    await fs.mkdir(path.dirname(entry), { recursive: true });
    await fs.writeFile(entry, '');
    const args = ['exec', '--model', 'test-model', '-'];
    const invocation = cliInvocation(path.join(root, 'codex.cmd'), args);
    assert.equal(invocation.command, process.execPath);
    assert.deepEqual(invocation.args, [entry, ...args]);
    assert.equal(invocation.shell, false);
    assert.deepEqual(args, ['exec', '--model', 'test-model', '-']);
});
