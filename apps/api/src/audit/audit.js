import { randomUUID } from 'node:crypto';
import { collection } from '../db/mongo.js';

/**
 * @typedef {{
 *   eventType: string,
 *   tenantId?: string | null,
 *   actorUserId?: string | null,
 *   actorRoleAssignmentId?: string | null,
 *   entityType?: string | null,
 *   entityId?: string | null,
 *   before?: unknown,
 *   after?: unknown,
 *   reason?: string | null,
 *   correlationId?: string | null,
 *   supportSession?: boolean,
 * }} AuditInput
 */

/**
 * The only writer of `audit_events`, and it only inserts: audit history is append-only
 * (checked by a test, since MongoDB has no triggers to block updates and deletes).
 * Never pass passwords, tokens or full bank numbers in before/after.
 * @param {AuditInput} event
 * @param {{ session?: import('mongodb').ClientSession }} [options]
 */
export async function recordAudit(event, options = {}) {
  const auditEvents = await collection('auditEvents');
  await auditEvents.insertOne(
    {
      _id: randomUUID(),
      tenantId: event.tenantId ?? null,
      actorUserId: event.actorUserId ?? null,
      actorRoleAssignmentId: event.actorRoleAssignmentId ?? null,
      eventType: event.eventType,
      entityType: event.entityType ?? null,
      entityId: event.entityId ?? null,
      before: event.before ?? null,
      after: event.after ?? null,
      reason: event.reason ?? null,
      correlationId: event.correlationId ?? null,
      supportSession: event.supportSession ?? false,
      createdAt: new Date(),
    },
    options,
  );
}

/**
 * Audit fields for an action taken inside an authenticated request.
 * @param {import('../http/router.js').Context} ctx
 */
export function actorOf(ctx) {
  return {
    tenantId: ctx.session?.tenantId ?? null,
    actorUserId: ctx.session?.userId ?? null,
    actorRoleAssignmentId: ctx.session?.roleAssignmentId ?? null,
    correlationId: ctx.requestId,
    supportSession: ctx.session?.supportSession ?? false,
  };
}
