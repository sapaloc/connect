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
 * Never pass passwords, tokens or full bank numbers in before/after.
 * @param {import('pg').Pool | import('pg').PoolClient} db
 * @param {AuditInput} event
 */
export async function recordAudit(db, event) {
  await db.query(
    `INSERT INTO audit_event (tenant_id, actor_user_id, actor_role_assignment_id, event_type, entity_type, entity_id,
       before_json, after_json, reason, correlation_id, support_session)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      event.tenantId ?? null,
      event.actorUserId ?? null,
      event.actorRoleAssignmentId ?? null,
      event.eventType,
      event.entityType ?? null,
      event.entityId ?? null,
      event.before === undefined ? null : JSON.stringify(event.before),
      event.after === undefined ? null : JSON.stringify(event.after),
      event.reason ?? null,
      event.correlationId ?? null,
      event.supportSession ?? false,
    ],
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
