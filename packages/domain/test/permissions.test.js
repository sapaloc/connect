import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { can, canInvite, LANDING, PERMISSIONS, permissionsFor, ROLES, surfaceOf } from '../src/index.js';

const ALL_ROLES = Object.values(ROLES);

/** Expected grants per role; any change to the matrix must update this table on purpose. */
const EXPECTED = {
  PLATFORM_ADMIN: ['surface.console', 'merchant.manage', 'user.list', 'user.invite', 'user.reset_link', 'partner.list', 'voucher.list'],
  TENANT_ADMIN: [
    'surface.console',
    'user.list',
    'user.invite',
    'user.reset_link',
    'merchant.settings',
    'partner.list',
    'partner.manage',
    'commercial_rule.manage',
    'voucher.issue',
    'voucher.list',
    'voucher.void',
  ],
  MANAGER: [
    'surface.console',
    'surface.counter',
    'partner.list',
    'voucher.issue',
    'voucher.list',
    'voucher.void',
    'voucher.validate',
    'redemption.create',
    'redemption.void',
  ],
  STAFF: ['surface.counter', 'voucher.validate', 'redemption.create'],
  PARTNER_ADMIN: ['surface.my'],
  REFERRER: ['surface.my'],
};

describe('@permission matrix', () => {
  for (const role of ALL_ROLES) {
    it(`${role} gets exactly the expected permissions`, () => {
      assert.deepEqual([...permissionsFor(role)].sort(), [...EXPECTED[role]].sort());
    });
  }

  it('every permission lists only known roles', () => {
    for (const [permission, roles] of Object.entries(PERMISSIONS)) {
      for (const role of roles) assert.ok(ALL_ROLES.includes(role), `${permission}: unknown role ${role}`);
    }
  });

  it('denies missing role and unknown permission', () => {
    assert.equal(can(null, 'surface.console'), false);
    assert.equal(can(undefined, 'surface.counter'), false);
    assert.equal(can(ROLES.TENANT_ADMIN, 'does.not.exist'), false);
  });

  it('Manager can void but cannot change rates (§18.5)', () => {
    assert.equal(can(ROLES.MANAGER, 'redemption.void'), true);
    assert.equal(can(ROLES.MANAGER, 'commercial_rule.manage'), false);
  });

  it('Staff cannot open the console (E2E-S1-01)', () => {
    assert.equal(can(ROLES.STAFF, 'surface.console'), false);
    assert.equal(LANDING.STAFF, '/counter');
  });

  it('every role lands on a surface it may open', () => {
    for (const role of ALL_ROLES) {
      assert.equal(can(role, `surface.${surfaceOf(LANDING[role])}`), true, role);
    }
  });

  it('only admins invite, and only the allowed roles', () => {
    assert.equal(canInvite(ROLES.TENANT_ADMIN, ROLES.STAFF), true);
    assert.equal(canInvite(ROLES.TENANT_ADMIN, ROLES.PLATFORM_ADMIN), false);
    assert.equal(canInvite(ROLES.PLATFORM_ADMIN, ROLES.TENANT_ADMIN), true);
    assert.equal(canInvite(ROLES.PLATFORM_ADMIN, ROLES.STAFF), false);
    for (const role of [ROLES.MANAGER, ROLES.STAFF, ROLES.PARTNER_ADMIN, ROLES.REFERRER]) {
      for (const target of ALL_ROLES) assert.equal(canInvite(role, target), false, `${role} -> ${target}`);
    }
  });
});

describe('surfaceOf', () => {
  it('maps paths to surfaces', () => {
    assert.equal(surfaceOf('/console/team'), 'console');
    assert.equal(surfaceOf('/counter'), 'counter');
    assert.equal(surfaceOf('/my'), 'my');
    assert.equal(surfaceOf('/login'), null);
  });
});
