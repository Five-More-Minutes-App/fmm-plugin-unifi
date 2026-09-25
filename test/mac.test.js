import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { normalizeMac, shortMac } from '../src/mac.js';

describe('normalizeMac', () => {
  it('accepts the ways people write an address, as one shape', () => {
    for (const written of ['aa:bb:cc:00:00:01', 'AA:BB:CC:00:00:01', 'aa-bb-cc-00-00-01', 'aabbcc000001', 'AABB.CC00.0001', '  aa:bb:cc:00:00:01  ']) {
      assert.equal(normalizeMac(written), 'aa:bb:cc:00:00:01', written);
    }
  });

  it('refuses everything else', () => {
    const notMacs = ['', ' ', 'aa:bb:cc:00:00', 'aa:bb:cc:00:00:01:02', 'aa:bb:cc:00:00:0g', 'aa:bb:cc-00:00:01', 'aabbcc00000',
      'aa:bb:cc:00:00:01\n; rm -rf', '../../etc/passwd', '<script>', 'aa:bb:cc:00:00:01 aa:bb:cc:00:00:02',
      undefined, null, 42, {}, ['aa:bb:cc:00:00:01']];
    for (const value of notMacs) assert.equal(normalizeMac(value), null, JSON.stringify(value));
  });

  it('refuses broadcast, group and empty addresses, which no device has', () => {
    for (const value of ['ff:ff:ff:ff:ff:ff', '01:00:5e:00:00:01', '33:33:00:00:00:01', '00:00:00:00:00:00']) {
      assert.equal(normalizeMac(value), null, value);
    }
  });
});

describe('shortMac', () => {
  it('is what is printed on the box', () => {
    assert.equal(shortMac('aa:bb:cc:0d:0e:0f'), '0D:0E:0F');
  });
});
