import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MERCHANT_SLUG_PATTERN, merchantSlug } from '../src/index.js';

describe('merchant slug', () => {
  it('strips Vietnamese accents and punctuation', () => {
    assert.equal(merchantSlug('Spa Number160 Sài Gòn'), 'spa-number160-sai-gon');
    assert.equal(merchantSlug('  Đà Lạt — Café & Bar!  '), 'da-lat-cafe-bar');
  });

  it('always matches the stored pattern when not empty', () => {
    for (const name of ['Number160', 'A', 'x'.repeat(80), 'Phở 24/7', 'Nhà hàng Ẩm Thực']) {
      assert.match(merchantSlug(name), MERCHANT_SLUG_PATTERN, name);
    }
  });

  it('returns empty for a name without letters or digits', () => {
    assert.equal(merchantSlug('!!!'), '');
  });
});
