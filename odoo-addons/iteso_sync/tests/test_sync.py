# -*- coding: utf-8 -*-
import datetime
from odoo.tests.common import TransactionCase
from odoo.exceptions import AccessError, ValidationError


class TestItesoSync(TransactionCase):

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        group_user = cls.env.ref("base.group_user")

        # Create a regular user representing a member (base.group_user)
        cls.member_user = cls.env["res.users"].create({
            "name": "Member Cashier",
            "login": "iteso-test-member-001",
            "email": "cashier@test.local",
            "group_ids": [(6, 0, [group_user.id])],
        })

    def test_01_idempotent_op_id(self):
        """Duplicate op_id returns previous result and does not create duplicate contact."""
        op_id = "018e0000-0000-7000-8000-000000000001"
        op = {
            "op_id": op_id,
            "device_id": "dev-01",
            "membership_id": "mem-01",
            "op_type": "contact.create",
            "seq": 1,
            "client_time": "2026-11-27 10:00:00",
            "payload": {"name": "Khách Hàng Thử Nghiệm", "phone": "0911222333"},
        }

        # First call
        res1 = self.env["iteso.sync.operation"].with_user(self.member_user).apply_operations([op])
        self.assertEqual(len(res1), 1)
        self.assertEqual(res1[0]["status"], "applied")
        contact_id1 = res1[0]["result"]["id"]
        self.assertTrue(contact_id1)

        # Check contact created
        contact = self.env["res.partner"].browse(contact_id1)
        self.assertEqual(contact.name, "Khách Hàng Thử Nghiệm")
        self.assertEqual(contact.phone, "0911222333")

        # Second call with same op_id
        res2 = self.env["iteso.sync.operation"].with_user(self.member_user).apply_operations([op])
        self.assertEqual(len(res2), 1)
        self.assertEqual(res2[0]["status"], "applied")
        self.assertEqual(res2[0]["result"]["id"], contact_id1)

        # Ensure no duplicate contact was created
        matching_contacts = self.env["res.partner"].search([("name", "=", "Khách Hàng Thử Nghiệm")])
        self.assertEqual(len(matching_contacts), 1)

    def test_02_atomic_savepoint_per_op(self):
        """One invalid operation in a batch does not roll back or fail other operations."""
        ops = [
            {
                "op_id": "018e0000-0000-7000-8000-000000000002",
                "device_id": "dev-01",
                "membership_id": "mem-01",
                "op_type": "contact.create",
                "seq": 1,
                "client_time": "2026-11-27 10:01:00",
                "payload": {"name": "Khách Hàng Hợp Lệ 1"},
            },
            {
                "op_id": "018e0000-0000-7000-8000-000000000003",
                "device_id": "dev-01",
                "membership_id": "mem-01",
                "op_type": "contact.create",
                "seq": 2,
                "client_time": "2026-11-27 10:02:00",
                "payload": {"name": ""},  # Invalid name: empty
            },
            {
                "op_id": "018e0000-0000-7000-8000-000000000004",
                "device_id": "dev-01",
                "membership_id": "mem-01",
                "op_type": "contact.create",
                "seq": 3,
                "client_time": "2026-11-27 10:03:00",
                "payload": {"name": "Khách Hàng Hợp Lệ 2"},
            },
        ]

        results = self.env["iteso.sync.operation"].with_user(self.member_user).apply_operations(ops)
        self.assertEqual(len(results), 3)

        self.assertEqual(results[0]["status"], "applied")
        self.assertTrue(results[0]["result"]["id"])

        self.assertEqual(results[1]["status"], "rejected")
        self.assertEqual(results[1]["reason"], "INVALID_NAME")

        self.assertEqual(results[2]["status"], "applied")
        self.assertTrue(results[2]["result"]["id"])

        # Check DB states
        self.assertTrue(self.env["res.partner"].browse(results[0]["result"]["id"]).exists())
        self.assertTrue(self.env["res.partner"].browse(results[2]["result"]["id"]).exists())

    def test_03_unknown_op_type(self):
        """Unsupported op_type returns status rejected with UNKNOWN_OP_TYPE."""
        op = {
            "op_id": "018e0000-0000-7000-8000-000000000005",
            "device_id": "dev-01",
            "membership_id": "mem-01",
            "op_type": "unsupported.action",
            "seq": 1,
            "client_time": "2026-11-27 10:04:00",
            "payload": {"data": "test"},
        }
        res = self.env["iteso.sync.operation"].with_user(self.member_user).apply_operations([op])
        self.assertEqual(len(res), 1)
        self.assertEqual(res[0]["status"], "rejected")
        self.assertEqual(res[0]["reason"], "UNKNOWN_OP_TYPE")

    def test_04_flag_review(self):
        """When flag_review is True, status is recorded as needs_review."""
        op = {
            "op_id": "018e0000-0000-7000-8000-000000000006",
            "device_id": "dev-01",
            "membership_id": "mem-01",
            "op_type": "contact.create",
            "seq": 1,
            "client_time": "2026-11-27 08:00:00",
            "payload": {"name": "Khách Cần Kiểm Tra"},
            "flag_review": True,
        }
        res = self.env["iteso.sync.operation"].with_user(self.member_user).apply_operations([op])
        self.assertEqual(len(res), 1)
        self.assertEqual(res[0]["status"], "needs_review")
        self.assertTrue(res[0]["result"]["id"])

    def test_05_outbox_tracking(self):
        """Partner create, write, unlink records outbox entries with correct actions."""
        # Create partner
        partner = self.env["res.partner"].create({"name": "Outbox Test Partner"})
        outbox_create = self.env["iteso.outbox"].search([
            ("model", "=", "res.partner"),
            ("res_id", "=", partner.id),
            ("action", "=", "create"),
        ], limit=1)
        self.assertTrue(outbox_create)

        # Write partner
        partner.write({"phone": "0999888777"})
        outbox_write = self.env["iteso.outbox"].search([
            ("model", "=", "res.partner"),
            ("res_id", "=", partner.id),
            ("action", "=", "write"),
        ], limit=1)
        self.assertTrue(outbox_write)

        # Unlink partner
        partner_id = partner.id
        partner.unlink()
        outbox_unlink = self.env["iteso.outbox"].search([
            ("model", "=", "res.partner"),
            ("res_id", "=", partner_id),
            ("action", "=", "unlink"),
        ], limit=1)
        self.assertTrue(outbox_unlink)

    def test_06_pull_pagination_and_reset(self):
        """Test pull with cursor=0, incremental cursor, and reset_required when cursor is too old."""
        # Create partner 1
        p1 = self.env["res.partner"].create({"name": "Pull Partner 1", "phone": "111"})
        # Create partner 2
        p2 = self.env["res.partner"].create({"name": "Pull Partner 2", "phone": "222"})

        # Pull cursor=0 (full pull)
        res_full = self.env["iteso.outbox"].with_user(self.member_user).pull("contacts", cursor=0, limit=500)
        self.assertFalse(res_full["reset_required"])
        p_ids = [r["id"] for r in res_full["records"]]
        self.assertIn(p1.id, p_ids)
        self.assertIn(p2.id, p_ids)
        cursor_after_full = res_full["next_cursor"]
        self.assertGreater(cursor_after_full, 0)

        # Update partner 2
        p2.write({"name": "Pull Partner 2 Updated"})

        # Incremental pull
        res_inc = self.env["iteso.outbox"].with_user(self.member_user).pull("contacts", cursor=cursor_after_full)
        self.assertFalse(res_inc["reset_required"])
        inc_ids = [r["id"] for r in res_inc["records"]]
        self.assertIn(p2.id, inc_ids)
        self.assertNotIn(p1.id, inc_ids)
        updated_p2 = [r for r in res_inc["records"] if r["id"] == p2.id][0]
        self.assertEqual(updated_p2["name"], "Pull Partner 2 Updated")

        # Test reset_required: create dummy old cursor before lowest id
        oldest_outbox = self.env["iteso.outbox"].search([("model", "=", "res.partner")], order="id asc", limit=1)
        if oldest_outbox:
            # If we delete oldest entries and request cursor below lowest
            oldest_id = oldest_outbox.id
            res_reset = self.env["iteso.outbox"].with_user(self.member_user).pull("contacts", cursor=max(1, oldest_id - 10))
            if oldest_id > 1:
                self.assertTrue(res_reset["reset_required"])

    def test_07_member_cannot_modify_ledger(self):
        """Member user cannot write or unlink iteso.sync.operation records (raises AccessError)."""
        op = {
            "op_id": "018e0000-0000-7000-8000-000000000007",
            "device_id": "dev-01",
            "membership_id": "mem-01",
            "op_type": "contact.create",
            "seq": 1,
            "client_time": "2026-11-27 10:05:00",
            "payload": {"name": "Khách Hàng Bảo Mật"},
        }
        res = self.env["iteso.sync.operation"].with_user(self.member_user).apply_operations([op])
        op_record = self.env["iteso.sync.operation"].search([("op_id", "=", op["op_id"])], limit=1)
        self.assertTrue(op_record)

        # Attempt to modify ledger row as member_user
        with self.assertRaises(AccessError):
            op_record.with_user(self.member_user).write({"status": "rejected"})

        # Attempt to delete ledger row as member_user
        with self.assertRaises(AccessError):
            op_record.with_user(self.member_user).unlink()
