# -*- coding: utf-8 -*-
import json
import logging
from odoo import api, fields, models
from odoo.exceptions import ValidationError

_logger = logging.getLogger(__name__)


class ItesoSyncOperation(models.Model):
    _name = "iteso.sync.operation"
    _description = "ITESO Sync Operation Ledger"
    _order = "id desc"

    op_id = fields.Char(string="Operation ID", required=True, index=True, copy=False)
    device_id = fields.Char(string="Device ID", required=True, index=True)
    membership_id = fields.Char(string="Membership ID", required=True, index=True)
    op_type = fields.Char(string="Operation Type", required=True, index=True)
    seq = fields.Integer(string="Sequence Number", default=0)
    client_time = fields.Datetime(string="Client Timestamp", required=True)
    server_time = fields.Datetime(
        string="Server Timestamp",
        default=fields.Datetime.now,
        required=True,
    )
    status = fields.Selection(
        [
            ("applied", "Applied"),
            ("rejected", "Rejected"),
            ("needs_review", "Needs Review"),
        ],
        string="Status",
        required=True,
    )
    result = fields.Text(string="Result JSON")
    error = fields.Char(string="Error Message / Code")

    _op_id_unique = models.Constraint(
        "unique(op_id)",
        "The operation ID must be unique across the ledger!",
    )

    @api.model
    def apply_operations(self, operations):
        """
        Public method to apply a batch of offline operations.
        Each operation executes in its own savepoint:
        1. If op_id already exists in ledger: returns cached result (idempotent).
        2. If new: invokes handler for op_type and records in ledger in the same savepoint.
        3. If op fails or validation error: records 'rejected' with reason.
        4. One failing op does not fail the rest of the batch.
        """
        results = []
        if not operations or not isinstance(operations, list):
            return results

        for op in operations:
            if not isinstance(op, dict):
                continue

            op_id = str(op.get("op_id") or "").strip()
            device_id = str(op.get("device_id") or "").strip()
            membership_id = str(op.get("membership_id") or "").strip()
            op_type = str(op.get("op_type") or "").strip()
            seq = int(op.get("seq") or 0)
            raw_client_time = op.get("client_time")
            payload = op.get("payload") or {}
            flag_review = bool(op.get("flag_review", False))

            if not op_id:
                continue

            # Parse client_time
            client_time_val = False
            if raw_client_time:
                try:
                    client_time_val = fields.Datetime.to_datetime(raw_client_time)
                except Exception:
                    client_time_val = fields.Datetime.now()
            else:
                client_time_val = fields.Datetime.now()

            # Execute each operation within its own savepoint
            try:
                with self.env.cr.savepoint():
                    # 1. Idempotency check: op_id already exists?
                    existing = self.search([("op_id", "=", op_id)], limit=1)
                    if existing:
                        cached_result = None
                        if existing.result:
                            try:
                                cached_result = json.loads(existing.result)
                            except Exception:
                                cached_result = existing.result
                        results.append({
                            "op_id": op_id,
                            "status": existing.status,
                            "result": cached_result,
                            "reason": existing.error,
                        })
                        continue

                    # 2. Process op_type
                    status = "applied"
                    reason = None
                    res_data = None

                    if op_type == "contact.create":
                        name = payload.get("name")
                        if not name or not isinstance(name, str) or not name.strip() or len(name.strip()) > 200:
                            status = "rejected"
                            reason = "INVALID_NAME"
                        else:
                            partner_vals = {
                                "name": name.strip(),
                            }
                            if payload.get("phone"):
                                partner_vals["phone"] = str(payload["phone"]).strip()
                            if payload.get("email"):
                                partner_vals["email"] = str(payload["email"]).strip()

                            partner = self.env["res.partner"].create(partner_vals)
                            res_data = {"id": partner.id}
                            status = "needs_review" if flag_review else "applied"
                    else:
                        status = "rejected"
                        reason = "UNKNOWN_OP_TYPE"

                    result_str = json.dumps(res_data) if res_data is not None else None

                    # 3. Write to ledger within the EXACT same savepoint
                    self.create({
                        "op_id": op_id,
                        "device_id": device_id,
                        "membership_id": membership_id,
                        "op_type": op_type,
                        "seq": seq,
                        "client_time": client_time_val,
                        "server_time": fields.Datetime.now(),
                        "status": status,
                        "result": result_str,
                        "error": reason,
                    })

                    results.append({
                        "op_id": op_id,
                        "status": status,
                        "result": res_data,
                        "reason": reason,
                    })
            except Exception as exc:
                _logger.exception("Failed to process sync operation %s: %s", op_id, exc)
                # Outer savepoint rolled back. Record rejected ledger row in new savepoint
                try:
                    with self.env.cr.savepoint():
                        self.create({
                            "op_id": op_id,
                            "device_id": device_id,
                            "membership_id": membership_id,
                            "op_type": op_type,
                            "seq": seq,
                            "client_time": client_time_val,
                            "server_time": fields.Datetime.now(),
                            "status": "rejected",
                            "result": None,
                            "error": str(exc),
                        })
                except Exception:
                    pass

                results.append({
                    "op_id": op_id,
                    "status": "rejected",
                    "result": None,
                    "reason": str(exc),
                })

        return results
