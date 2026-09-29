import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { brandColorFor, brandTextColor, contrastRatio, detectImageType, parseBrandColor } from '../src/index.js';

describe('brand colour', () => {
  it('normalises hex input', () => {
    assert.equal(parseBrandColor('#1a2b3c'), '#1A2B3C');
    assert.equal(parseBrandColor(' abc '), '#AABBCC');
    assert.equal(parseBrandColor('red'), null);
    assert.equal(parseBrandColor('#12345'), null);
  });

  it('picks the readable text colour', () => {
    assert.equal(brandTextColor('#17262D'), '#FFFFFF');
    assert.equal(brandTextColor('#F6E7C1'), '#1F2823');
    assert.ok(contrastRatio('#000000', '#FFFFFF') > 20);
  });

  it('refuses a colour no text colour can read on', () => {
    assert.deepEqual(brandColorFor('#28332C'), { color: '#28332C', textColor: '#FFFFFF' });
    assert.deepEqual(brandColorFor('not a colour'), { error: 'BRAND_COLOR_INVALID' });
    assert.deepEqual(brandColorFor('#7A7A7A'), { error: 'BRAND_COLOR_LOW_CONTRAST' });
  });
});

describe('image type from magic bytes', () => {
  const bytes = (/** @type {number[]} */ head, /** @type {string} */ tail = '') =>
    new Uint8Array([...head, ...Buffer.from(tail), ...new Array(16).fill(0)]);

  it('recognises JPEG, PNG, WebP and HEIC', () => {
    assert.equal(detectImageType(bytes([0xff, 0xd8, 0xff, 0xe0])), 'jpeg');
    assert.equal(detectImageType(bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'png');
    assert.equal(detectImageType(new Uint8Array([...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WEBPVP8 ')])), 'webp');
    assert.equal(detectImageType(new Uint8Array([0, 0, 0, 24, ...Buffer.from('ftypheic'), 0, 0, 0, 0])), 'heic');
  });

  it('refuses anything else, whatever the file name says', () => {
    assert.equal(detectImageType(bytes([], 'GIF89a')), null);
    assert.equal(detectImageType(bytes([], '<svg xmlns=')), null);
    assert.equal(detectImageType(new Uint8Array([0xff, 0xd8])), null);
  });
});
