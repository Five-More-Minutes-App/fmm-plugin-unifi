import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { Store, cleanLabel } from '../src/store.js';

const dirs = [];
const fresh = () => {
  const dir = mkdtempSync(join(tmpdir(), 'fmm-unifi-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('the store', () => {
  it('starts empty, and blocks nothing until told to', () => {
    const store = new Store(fresh());

    assert.equal(store.mode, 'locked');
    assert.deepEqual(store.selection, []);
    assert.deepEqual(store.blockedByUs, []);
  });

  it('remembers what was chosen, and what it blocked, across a restart', () => {
    const dir = fresh();
    const first = new Store(dir);
    first.saveSettings('not-running', [{ mac: 'AA-BB-CC-00-00-01', label: 'iPad' }, { mac: 'aa:bb:cc:00:00:02' }]);
    first.claim('aa:bb:cc:00:00:01');

    const second = new Store(dir);

    assert.equal(second.mode, 'not-running');
    assert.deepEqual(second.selection, [{ mac: 'aa:bb:cc:00:00:01', label: 'iPad' }, { mac: 'aa:bb:cc:00:00:02', label: '' }]);
    assert.deepEqual(second.blockedByUs, ['aa:bb:cc:00:00:01']);
  });

  it('keeps a device once, whatever it is written as', () => {
    const store = new Store(fresh());
    store.saveSettings('locked', [{ mac: 'aa:bb:cc:00:00:01' }, { mac: 'AA-BB-CC-00-00-01' }, { mac: 'nonsense' }]);

    assert.equal(store.selection.length, 1);
  });

  it('claims and releases, and does neither twice', () => {
    const store = new Store(fresh());

    store.claim('aa:bb:cc:00:00:01');
    store.claim('aa:bb:cc:00:00:01');
    assert.deepEqual(store.blockedByUs, ['aa:bb:cc:00:00:01']);

    store.release('aa:bb:cc:00:00:01');
    store.release('aa:bb:cc:00:00:01');
    assert.deepEqual(store.blockedByUs, []);
  });

  it('does not let a caller change it by changing what it was given', () => {
    const store = new Store(fresh());
    store.claim('aa:bb:cc:00:00:01');

    store.blockedByUs.push('aa:bb:cc:00:00:02');
    store.selection.push({ mac: 'aa:bb:cc:00:00:02', label: '' });

    assert.deepEqual(store.blockedByUs, ['aa:bb:cc:00:00:01']);
    assert.deepEqual(store.selection, []);
  });

  it('limits how many devices can be chosen, and saves nothing when it refuses', () => {
    const store = new Store(fresh());
    const many = Array.from({ length: 51 }, (_, i) => ({ mac: `aa:bb:cc:00:00:${(i * 2).toString(16).padStart(2, '0')}` }));

    assert.throws(() => store.saveSettings('locked', many), RangeError);
    assert.deepEqual(store.selection, []);
  });

  it('leaves no temporary file behind, and keeps the file private to its owner', () => {
    const dir = fresh();
    new Store(dir).claim('aa:bb:cc:00:00:01');

    assert.deepEqual(readdirSync(dir), ['state.json']);
    if (process.platform !== 'win32') assert.equal(statSync(join(dir, 'state.json')).mode & 0o077, 0);
  });

  it('starts again, keeping the file for a person, when it cannot be read', () => {
    const dir = fresh();
    writeFileSync(join(dir, 'state.json'), '{ this is not json');

    const store = new Store(dir);

    assert.deepEqual(store.selection, []);
    assert.equal(store.mode, 'locked');
    assert.ok(readdirSync(dir).some((f) => f.startsWith('state.json.unreadable-')), 'the unreadable file is kept');
  });

  it('treats a hand-edited file as untrusted: only real addresses, known modes, sane sizes', () => {
    const dir = fresh();
    writeFileSync(join(dir, 'state.json'), JSON.stringify({
      version: 1,
      mode: 'everything',
      selection: [{ mac: 'aa:bb:cc:00:00:01', label: 'ok\u0007'.repeat(40) }, { mac: '; drop' }, null, 5],
      blockedByUs: ['ff:ff:ff:ff:ff:ff', 'AA-BB-CC-00-00-02', 7, 'aa:bb:cc:00:00:02'],
    }));

    const store = new Store(dir);

    assert.equal(store.mode, 'locked');
    assert.equal(store.selection.length, 1);
    assert.ok(store.selection[0].label.length <= 60);
    assert.ok(!/[\u0000-\u001f]/.test(store.selection[0].label));
    assert.deepEqual(store.blockedByUs, ['aa:bb:cc:00:00:02']);
  });

  it('writes valid JSON with a trailing newline', () => {
    const dir = fresh();
    new Store(dir).saveSettings('locked', []);

    const text = readFileSync(join(dir, 'state.json'), 'utf8');
    assert.ok(text.endsWith('\n'));
    assert.equal(JSON.parse(text).version, 1);
  });
});

describe('cleanLabel', () => {
  it('removes control characters, trims, and shortens', () => {
    assert.equal(cleanLabel('  hi\nthere\u0000  '), 'hi there');
    assert.equal(cleanLabel('x'.repeat(100)).length, 60);
    assert.equal(cleanLabel(undefined), '');
    assert.equal(cleanLabel(42), '');
  });
});
