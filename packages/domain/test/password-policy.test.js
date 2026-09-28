import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { passwordPolicyErrors } from '../src/index.js';

describe('password policy (§8.2)', () => {
  it('accepts a password meeting every rule', () => {
    assert.deepEqual(passwordPolicyErrors('Connect#2026'), []);
  });

  it('enforces length 8–32', () => {
    assert.deepEqual(passwordPolicyErrors('Ab1#xyz'), ['LENGTH']);
    assert.deepEqual(passwordPolicyErrors('Ab1#xyzw'), []);
    assert.deepEqual(passwordPolicyErrors(`Ab1#${'x'.repeat(28)}`), []);
    assert.deepEqual(passwordPolicyErrors(`Ab1#${'x'.repeat(29)}`), ['LENGTH']);
  });

  it('reports each missing character class', () => {
    assert.deepEqual(passwordPolicyErrors('connect#2026'), ['UPPER']);
    assert.deepEqual(passwordPolicyErrors('CONNECT#2026'), ['LOWER']);
    assert.deepEqual(passwordPolicyErrors('Connect#abcd'), ['DIGIT']);
    assert.deepEqual(passwordPolicyErrors('Connect2026'), ['SPECIAL']);
  });

  it('treats Vietnamese letters as letters, not special characters', () => {
    assert.deepEqual(passwordPolicyErrors('Đăngnhập2026'), ['SPECIAL']);
    assert.deepEqual(passwordPolicyErrors('đăngnhập#2026'), ['UPPER']);
  });

  it('rejects non-strings', () => {
    assert.deepEqual(passwordPolicyErrors(undefined), ['LENGTH', 'UPPER', 'LOWER', 'DIGIT', 'SPECIAL']);
  });
});
