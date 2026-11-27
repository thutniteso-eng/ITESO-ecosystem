import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { PlatformService } from '../features/platform.service';
import { OdooCredentialService } from '../odoo/odoo-credential.service';
import { OdooService } from '../odoo/odoo.service';

export interface PushOperation {
  op_id: string;
  device_id: string;
  roster_jti: string;
  membership_id: string;
  client_time: string;
  seq: number;
  op_type: string;
  payload: Record<string, unknown>;
}

export interface OperationResult {
  op_id: string;
  status: 'applied' | 'rejected' | 'needs_review';
  result?: Record<string, unknown>;
  error?: string;
}

export interface PullDatasetResult {
  reset_required: boolean;
  records: Array<Record<string, unknown>>;
  next_cursor: number;
}

interface RosterIssueRow {
  jti: string;
  device_id: string;
  tenant_id: string;
  member_ids: string[];
  issued_at: Date;
  expires_at: Date;
}

@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);
  private readonly controlPlaneUrl: string;

  constructor(
    private readonly platformService: PlatformService,
    private readonly credentialService: OdooCredentialService,
    private readonly odooService: OdooService,
  ) {
    this.controlPlaneUrl = (process.env.CONTROL_PLANE_URL || 'http://control-plane:3100').replace(/\/+$/, '');
  }

  // --------------------------------------------------------------------------
  // POST /v1/sync/push
  // --------------------------------------------------------------------------
  async push(
    tenantCode: string,
    deviceId: string,
    operations: PushOperation[],
  ): Promise<{ results: OperationResult[] }> {
    if (!Array.isArray(operations) || operations.length === 0 || operations.length > 200) {
      throw new BadRequestException({
        error: 'INVALID_BATCH_SIZE',
        message: 'operations must be a non-empty array with at most 200 items',
      });
    }

    const tenant = await this.platformService.getActiveTenant(tenantCode);
    const now = new Date();
    const serverTimeMs = now.getTime();

    // Map to preserve original order
    const results: OperationResult[] = new Array(operations.length);

    // Group valid operations by membershipId for batching to Odoo
    const validOpsByMember = new Map<string, Array<{ op: PushOperation; originalIndex: number; flagReview: boolean }>>();

    // Cache roster lookups within this request
    const rosterCache = new Map<string, RosterIssueRow | null>();

    for (let i = 0; i < operations.length; i++) {
      const op = operations[i];

      // Format validation
      if (
        !op.op_id ||
        !op.device_id ||
        !op.roster_jti ||
        !op.membership_id ||
        !op.client_time ||
        typeof op.seq !== 'number' ||
        !op.op_type ||
        !op.payload
      ) {
        results[i] = {
          op_id: op.op_id || `unknown_${i}`,
          status: 'rejected',
          error: 'INVALID_OPERATION_FORMAT',
        };
        continue;
      }

      // Device binding validation: op.device_id must match authenticated session device
      if (op.device_id !== deviceId) {
        results[i] = {
          op_id: op.op_id,
          status: 'rejected',
          error: 'DEVICE_MISMATCH',
        };
        continue;
      }

      // Time parsing
      const clientTimeDate = new Date(op.client_time);
      if (isNaN(clientTimeDate.getTime())) {
        results[i] = {
          op_id: op.op_id,
          status: 'rejected',
          error: 'INVALID_TIMESTAMP',
        };
        continue;
      }
      const clientTimeMs = clientTimeDate.getTime();

      // Rule: client_time cannot be > 5 minutes in the future
      if (clientTimeMs > serverTimeMs + 5 * 60 * 1000) {
        results[i] = {
          op_id: op.op_id,
          status: 'rejected',
          error: 'FUTURE_TIMESTAMP',
        };
        continue;
      }

      // Verify roster_jti
      let roster = rosterCache.get(op.roster_jti);
      if (roster === undefined) {
        const queryRes = await this.credentialService.pgPool.query<RosterIssueRow>(
          `SELECT jti, device_id, tenant_id, member_ids, issued_at, expires_at
           FROM pos_roster_issues
           WHERE jti = $1`,
          [op.roster_jti],
        );
        roster = queryRes.rows[0] || null;
        rosterCache.set(op.roster_jti, roster);
      }

      if (!roster) {
        results[i] = {
          op_id: op.op_id,
          status: 'rejected',
          error: 'ROSTER_NOT_FOUND',
        };
        continue;
      }

      // Roster must belong to this device
      if (roster.device_id !== deviceId || roster.tenant_id !== tenant.id) {
        results[i] = {
          op_id: op.op_id,
          status: 'rejected',
          error: 'ROSTER_MISMATCH',
        };
        continue;
      }

      // Membership must be in roster
      if (!roster.member_ids.includes(op.membership_id)) {
        results[i] = {
          op_id: op.op_id,
          status: 'rejected',
          error: 'MEMBER_NOT_IN_ROSTER',
        };
        continue;
      }

      // Tolerance window: [issued_at - 10m, expires_at + 10m]
      const issuedAtMs = new Date(roster.issued_at).getTime();
      const expiresAtMs = new Date(roster.expires_at).getTime();
      const lowerBound = issuedAtMs - 10 * 60 * 1000;
      const upperBound = expiresAtMs + 10 * 60 * 1000;

      if (clientTimeMs < lowerBound || clientTimeMs > upperBound) {
        results[i] = {
          op_id: op.op_id,
          status: 'rejected',
          error: 'ROSTER_EXPIRED',
        };
        continue;
      }

      // Check member's Odoo credentials in membership_odoo_users
      // Gateway has SELECT on membership_odoo_users (evict cache to ensure fresh check if disabled)
      this.credentialService.evictCache(op.membership_id);
      let memberCred: { apiKey: string; odooUid: number } | null = null;
      try {
        memberCred = await this.credentialService.getMemberCredential(
          op.membership_id,
          tenantCode,
          tenant.id,
        );
      } catch {
        results[i] = {
          op_id: op.op_id,
          status: 'rejected',
          error: 'MEMBER_DISABLED',
        };
        continue;
      }

      if (!memberCred) {
        results[i] = {
          op_id: op.op_id,
          status: 'rejected',
          error: 'MEMBER_DISABLED',
        };
        continue;
      }

      // Check current permissions of membership via Control Plane internal endpoint
      let flagReview = false;
      try {
        const permRes = await fetch(
          `${this.controlPlaneUrl}/v1/internal/memberships/${op.membership_id}/permissions`,
          {
            headers: { 'X-Tenant': tenantCode },
            signal: AbortSignal.timeout(3000),
          },
        );
        if (!permRes.ok) {
          flagReview = true;
        } else {
          const permData = (await permRes.json()) as { perms?: string[] };
          if (!permData.perms || !permData.perms.includes('pos.session.open')) {
            flagReview = true;
          }
        }
      } catch {
        flagReview = true;
      }

      // Skew check: if |server_time - client_time| > 10m -> flag_review
      const skewMs = Math.abs(serverTimeMs - clientTimeMs);
      if (skewMs > 10 * 60 * 1000) {
        flagReview = true;
      }

      // Group into member batch
      let list = validOpsByMember.get(op.membership_id);
      if (!list) {
        list = [];
        validOpsByMember.set(op.membership_id, list);
      }
      list.push({ op, originalIndex: i, flagReview });
    }

    // Now execute calls to Odoo for each member's batch
    for (const [membershipId, batch] of validOpsByMember.entries()) {
      let memberCred: { apiKey: string; odooUid: number };
      try {
        memberCred = await this.credentialService.getMemberCredential(
          membershipId,
          tenantCode,
          tenant.id,
        );
      } catch {
        for (const item of batch) {
          results[item.originalIndex] = {
            op_id: item.op.op_id,
            status: 'rejected',
            error: 'MEMBER_DISABLED',
          };
        }
        continue;
      }

      const odooPayloadOps = batch.map((item) => ({
        op_id: item.op.op_id,
        device_id: item.op.device_id,
        membership_id: item.op.membership_id,
        op_type: item.op.op_type,
        seq: item.op.seq,
        client_time: item.op.client_time,
        payload: item.op.payload,
        flag_review: item.flagReview,
      }));

      try {
        const response = await this.odooService.executeJson2Call(
          tenant.dbName,
          memberCred.apiKey,
          'iteso.sync.operation',
          'apply_operations',
          { operations: odooPayloadOps },
        );

        if (!response.ok) {
          const errText = await response.text().catch(() => '');
          this.logger.error(`Odoo apply_operations failed: ${response.status} ${errText}`);
          for (const item of batch) {
            results[item.originalIndex] = {
              op_id: item.op.op_id,
              status: 'rejected',
              error: 'ODOO_EXECUTION_ERROR',
            };
          }
          continue;
        }

        const odooData = (await response.json()) as { result?: OperationResult[] } | OperationResult[];
        const odooResults: OperationResult[] = Array.isArray(odooData)
          ? odooData
          : odooData?.result || [];

        // Match results by op_id
        const resultMap = new Map<string, OperationResult>();
        if (Array.isArray(odooResults)) {
          for (const r of odooResults) {
            resultMap.set(r.op_id, r);
          }
        }

        for (const item of batch) {
          const res = resultMap.get(item.op.op_id);
          if (res) {
            results[item.originalIndex] = res;
          } else {
            results[item.originalIndex] = {
              op_id: item.op.op_id,
              status: 'rejected',
              error: 'NO_RESPONSE_FROM_ODOO',
            };
          }
        }
      } catch (err) {
        this.logger.error(`Error sending operations to Odoo:`, err);
        for (const item of batch) {
          results[item.originalIndex] = {
            op_id: item.op.op_id,
            status: 'rejected',
            error: 'ODOO_CALL_FAILED',
          };
        }
      }
    }

    return { results };
  }

  // --------------------------------------------------------------------------
  // GET /v1/sync/pull
  // --------------------------------------------------------------------------
  async pull(
    tenantCode: string,
    deviceId: string,
    dataset: string,
    cursor: number,
    limit: number,
  ): Promise<PullDatasetResult> {
    if (!dataset || dataset !== 'contacts') {
      throw new BadRequestException({
        error: 'INVALID_DATASET',
        message: "Only 'contacts' dataset is supported in TASK-006",
      });
    }

    const tenant = await this.platformService.getActiveTenant(tenantCode);

    // Call Control-Plane internal API for device read-only Odoo credentials
    const credRes = await fetch(
      `${this.controlPlaneUrl}/v1/internal/pos/devices/${deviceId}/odoo-credential`,
      {
        headers: { 'X-Tenant': tenantCode },
        signal: AbortSignal.timeout(3000),
      },
    );

    if (!credRes.ok) {
      throw new ForbiddenException({
        error: 'DEVICE_CREDENTIAL_FAILED',
        message: 'Could not obtain device Odoo credential from control plane',
      });
    }

    const deviceCred = (await credRes.json()) as { apiKey: string; odooUid: number };

    // Call Odoo iteso.outbox pull
    const response = await this.odooService.executeJson2Call(
      tenant.dbName,
      deviceCred.apiKey,
      'iteso.outbox',
      'pull',
      {
        dataset,
        cursor: cursor || 0,
        limit: limit || 500,
      },
    );

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      this.logger.error(`Odoo iteso.outbox pull failed: ${response.status} ${errText}`);
      throw new BadRequestException({
        error: 'PULL_FAILED',
        message: 'Failed to pull changes from Odoo',
      });
    }

    const pullData = (await response.json()) as { result?: PullDatasetResult } | PullDatasetResult;
    if ('result' in pullData && pullData.result) {
      return pullData.result;
    }
    return pullData as PullDatasetResult;
  }
}
