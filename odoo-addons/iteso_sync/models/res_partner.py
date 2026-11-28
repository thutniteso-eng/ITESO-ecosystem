# -*- coding: utf-8 -*-
from odoo import api, models


class ResPartner(models.Model):
    _inherit = "res.partner"

    @api.model_create_multi
    def create(self, vals_list):
        records = super().create(vals_list)
        outbox_vals = [
            {
                "model": "res.partner",
                "res_id": r.id,
                "action": "create",
            }
            for r in records
        ]
        self.env["iteso.outbox"].sudo().create(outbox_vals)
        return records

    def write(self, vals):
        res = super().write(vals)
        outbox_vals = [
            {
                "model": "res.partner",
                "res_id": r.id,
                "action": "write",
            }
            for r in self
        ]
        self.env["iteso.outbox"].sudo().create(outbox_vals)
        return res

    def unlink(self):
        outbox_vals = [
            {
                "model": "res.partner",
                "res_id": r.id,
                "action": "unlink",
            }
            for r in self
        ]
        self.env["iteso.outbox"].sudo().create(outbox_vals)
        return super().unlink()
