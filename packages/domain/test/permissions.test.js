import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { can, canInvite, LANDING, PERMISSIONS, permissionsFor, roleConflict, ROLES, roleSide, surfaceOf } from '../src/index.js';

const ALL_ROLES = Object.values(ROLES);

/** Expected grants per role; any change to the matrix must update this table on purpose. */
const EXPECTED = {
  PLATFORM_ADMIN: [
    'surface.console',
    'merchant.manage',
    'user.list',
    'user.invite',
    'user.reset_link',
    'partner.list',
    'voucher.list',
    'commission.list',
  ],
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
    'commission.list',
    'commission.settle',
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
  PARTNER_ADMIN: ['surface.my', 'commission.view_own', 'partner.profile_own'],
  REFERRER: ['surface.my', 'commission.view_own', 'partner.profile_own'],
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

  it('Staff and Manager never see commission (DEC-088)', () => {
    assert.equal(can(ROLES.STAFF, 'commission.list'), false);
    assert.equal(can(ROLES.MANAGER, 'commission.list'), false);
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

describe('roleConflict: one side per person', () => {
  const A = 'tenant-a';
  const B = 'tenant-b';

  it('a partner may work with many merchants', () => {
    assert.equal(roleConflict([{ role: ROLES.PARTNER_ADMIN, tenantId: A }], { role: ROLES.PARTNER_ADMIN, tenantId: B }), null);
    assert.equal(roleConflict([{ role: ROLES.REFERRER, tenantId: A }], { role: ROLES.PARTNER_ADMIN, tenantId: B }), null);
  });

  it('never mixes merchant team, partner and platform roles', () => {
    assert.equal(roleConflict([{ role: ROLES.PARTNER_ADMIN, tenantId: A }], { role: ROLES.STAFF, tenantId: B }), 'ROLE_SIDE_CONFLICT');
    assert.equal(roleConflict([{ role: ROLES.MANAGER, tenantId: A }], { role: ROLES.REFERRER, tenantId: A }), 'ROLE_SIDE_CONFLICT');
    assert.equal(roleConflict([{ role: ROLES.PLATFORM_ADMIN, tenantId: null }], { role: ROLES.TENANT_ADMIN, tenantId: A }), 'ROLE_SIDE_CONFLICT');
  });

  it('one merchant role per merchant; the same role again is not a conflict', () => {
    assert.equal(roleConflict([{ role: ROLES.TENANT_ADMIN, tenantId: A }], { role: ROLES.MANAGER, tenantId: A }), 'ROLE_ALREADY_IN_MERCHANT');
    assert.equal(roleConflict([{ role: ROLES.STAFF, tenantId: A }], { role: ROLES.STAFF, tenantId: A }), null);
    assert.equal(roleConflict([{ role: ROLES.STAFF, tenantId: A }], { role: ROLES.MANAGER, tenantId: B }), null);
  });

  it('maps every role to a side', () => {
    assert.deepEqual(ALL_ROLES.map(roleSide), ['PLATFORM', 'MERCHANT', 'MERCHANT', 'MERCHANT', 'PARTNER', 'PARTNER']);
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
