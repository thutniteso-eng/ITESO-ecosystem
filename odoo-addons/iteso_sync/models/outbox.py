# -*- coding: utf-8 -*-
import datetime
import logging
from odoo import api, fields, models
from odoo.exceptions import ValidationError

_logger = logging.getLogger(__name__)


class ItesoOutbox(models.Model):
    _name = "iteso.outbox"
    _description = "ITESO Sync Outbox Log"
    _order = "id asc"

    model = fields.Char(string="Model", required=True, index=True)
    res_id = fields.Integer(string="Record ID", required=True, index=True)
    action = fields.Selection(
        [
            ("create", "Create"),
            ("write", "Write"),
            ("unlink", "Unlink"),
        ],
        string="Action",
        required=True,
    )
    created_at = fields.Datetime(
        string="Created At",
        default=fields.Datetime.now,
        required=True,
        index=True,
    )

    @api.model
    def purge_old_outbox(self, days=30):
        """Purge outbox records older than retention period (default 30 days)."""
        cutoff = fields.Datetime.now() - datetime.timedelta(days=int(days))
        old_records = self.search([("created_at", "<", cutoff)])
        count = len(old_records)
        if old_records:
            old_records.unlink()
        _logger.info("Purged %d old outbox records older than %d days", count, days)
        return count

    @api.model
    def pull(self, dataset, cursor=0, limit=500):
        """
        Pull updated dataset records after cursor.
        dataset="contacts":
          - cursor=0: returns all active/inactive partners, next_cursor=latest outbox id
          - cursor>0 and older than oldest outbox: returns reset_required: True
          - cursor>0: returns changes (create/write/unlink) since cursor
        """
        if dataset != "contacts":
            raise ValidationError(f"Dataset '{dataset}' is not supported.")

        limit = min(max(int(limit or 100), 1), 500)
        cursor = int(cursor or 0)

        # Check if cursor is older than the oldest retained outbox entry
        oldest = self.search([("model", "=", "res.partner")], order="id asc", limit=1)
        if cursor > 0 and oldest and cursor < oldest.id:
            return {
                "reset_required": True,
                "records": [],
                "next_cursor": cursor,
            }

        if cursor == 0:
            # Full snapshot download
            partners = self.env["res.partner"].search([("active", "in", [True, False])], order="id asc", limit=limit)
            records = [
                {
                    "id": p.id,
                    "name": p.name,
                    "phone": p.phone or False,
                    "email": p.email or False,
                    "active": p.active,
                    "deleted": False,
                }
                for p in partners
            ]

            latest_outbox = self.search([("model", "=", "res.partner")], order="id desc", limit=1)
            next_cursor = latest_outbox.id if latest_outbox else 0
            return {
                "reset_required": False,
                "records": records,
                "next_cursor": next_cursor,
            }

        # Incremental pull
        outbox_entries = self.search(
            [
                ("model", "=", "res.partner"),
                ("id", ">", cursor),
            ],
            order="id asc",
            limit=limit,
        )

        if not outbox_entries:
            return {
                "reset_required": False,
                "records": [],
                "next_cursor": cursor,
            }

        next_cursor = outbox_entries[-1].id

        # Collate unique records preserving order, tracking latest action
        records_by_id = {}
        for entry in outbox_entries:
            res_id = entry.res_id
            if entry.action == "unlink":
                records_by_id[res_id] = {
                    "id": res_id,
                    "deleted": True,
                }
            else:
                partner = self.env["res.partner"].browse(res_id)
                if not partner.exists():
                    records_by_id[res_id] = {
                        "id": res_id,
                        "deleted": True,
                    }
                else:
                    records_by_id[res_id] = {
                        "id": partner.id,
                        "name": partner.name,
                        "phone": partner.phone or False,
                        "email": partner.email or False,
                        "active": partner.active,
                        "deleted": False,
                    }

        return {
            "reset_required": False,
            "records": list(records_by_id.values()),
            "next_cursor": next_cursor,
        }
