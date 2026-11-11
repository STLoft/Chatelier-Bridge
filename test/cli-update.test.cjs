'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { cliPackage, firstWindowsCommand } = require('../cli-update.cjs');

test('Windows command resolution respects PATH order and skips the extensionless shell wrapper', () => {
    const path = require('node:path');
    const commands = [path.join('npm', 'codex'), path.join('npm', 'codex.cmd'), path.join('standalone', 'codex.exe')];
    assert.equal(firstWindowsCommand(commands), commands[1]);
    assert.equal(firstWindowsCommand([commands[2], commands[1]]), commands[2]);
});
test('package choice is fixed by environment rather than request data', () => {
    assert.equal(cliPackage(false), '@openai/codex');
    assert.equal(cliPackage(true), '@mmmbuto/codex-cli-termux');
});
