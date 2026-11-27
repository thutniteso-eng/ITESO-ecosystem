# -*- coding: utf-8 -*-
from odoo.tests.common import TransactionCase
from odoo.exceptions import AccessError, ValidationError


class TestItesoProvisioning(TransactionCase):

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        group_system = cls.env.ref("base.group_system")
        group_user = cls.env.ref("base.group_user")

        # Create iteso_system user
        cls.system_user = cls.env["res.users"].create({
            "name": "ITESO System Service",
            "login": "iteso_system",
            "email": "system@iteso.local",
            "group_ids": [(6, 0, [group_system.id])],
        })

        # Create normal regular user
        cls.regular_user = cls.env["res.users"].create({
            "name": "Regular User",
            "login": "regular_test_user",
            "email": "regular@test.local",
            "group_ids": [(6, 0, [group_user.id])],
        })

    def test_01_caller_permission_check(self):
        """Only iteso_system can call provisioning methods."""
        # Call with regular user -> AccessError
        with self.assertRaises(AccessError):
            self.env["iteso.provisioning"].with_user(self.regular_user).provision_member(
                "mid-001", "Member One"
            )

        # Call with admin (admin is not iteso_system) -> AccessError
        admin_user = self.env.ref("base.user_admin")
        with self.assertRaises(AccessError):
            self.env["iteso.provisioning"].with_user(admin_user).provision_member(
                "mid-001", "Member One"
            )

        # Call with iteso_system -> Success
        res = self.env["iteso.provisioning"].with_user(self.system_user).provision_member(
            "mid-001", "Member One"
        )
        self.assertEqual(res["login"], "iteso-mid-001")

    def test_02_group_whitelist_validation(self):
        """Cannot assign base.group_system or non-whitelisted groups."""
        # Forbidden group base.group_system
        with self.assertRaises(AccessError):
            self.env["iteso.provisioning"].with_user(self.system_user).provision_member(
                "mid-002", "Privileged Member", group_xmlids=["base.group_system"]
            )

        # Forbidden group base.group_erp_manager
        with self.assertRaises(AccessError):
            self.env["iteso.provisioning"].with_user(self.system_user).provision_member(
                "mid-002", "Manager Member", group_xmlids=["base.group_erp_manager"]
            )

        # Non-whitelisted group
        with self.assertRaises(ValidationError):
            self.env["iteso.provisioning"].with_user(self.system_user).provision_member(
                "mid-002", "Random Member", group_xmlids=["base.group_partner_manager"]
            )

    def test_03_idempotent_provisioning(self):
        """Calling provision_member multiple times updates existing user without duplicates."""
        res1 = self.env["iteso.provisioning"].with_user(self.system_user).provision_member(
            "mid-003", "Member 3 Initial"
        )
        uid1 = res1["uid"]

        res2 = self.env["iteso.provisioning"].with_user(self.system_user).provision_member(
            "mid-003", "Member 3 Updated"
        )
        uid2 = res2["uid"]

        self.assertEqual(uid1, uid2)
        user = self.env["res.users"].browse(uid1)
        self.assertEqual(user.name, "Member 3 Updated")
        self.assertTrue(user.active)

    def test_04_issue_and_revoke_keys(self):
        """Issue keys, verify raw key returned once, and revoke keys keeping newest."""
        res = self.env["iteso.provisioning"].with_user(self.system_user).provision_member(
            "mid-004", "Member 4"
        )
        uid = res["uid"]

        # Issue first key
        k1 = self.env["iteso.provisioning"].with_user(self.system_user).issue_member_key(uid, ttl_days=30)
        self.assertTrue(k1["key"])
        self.assertTrue(k1["expires_at"])

        # Issue second key (simulate rotation)
        k2 = self.env["iteso.provisioning"].with_user(self.system_user).issue_member_key(uid, ttl_days=30)
        self.assertTrue(k2["key"])

        # Total keys = 2
        keys = self.env["res.users.apikeys"].search([("user_id", "=", uid), ("name", "=", "iteso-gateway")])
        self.assertEqual(len(keys), 2)

        # Revoke keeping newest
        rev = self.env["iteso.provisioning"].with_user(self.system_user).revoke_member_keys(uid, keep_newest=True)
        self.assertEqual(rev["removed"], 1)

        keys_after = self.env["res.users.apikeys"].search([("user_id", "=", uid), ("name", "=", "iteso-gateway")])
        self.assertEqual(len(keys_after), 1)

    def test_05_disable_member(self):
        """disable_member sets active = False and removes all API keys."""
        res = self.env["iteso.provisioning"].with_user(self.system_user).provision_member(
            "mid-005", "Member 5"
        )
        uid = res["uid"]
        self.env["iteso.provisioning"].with_user(self.system_user).issue_member_key(uid, ttl_days=30)

        # Disable
        dis = self.env["iteso.provisioning"].with_user(self.system_user).disable_member(uid)
        self.assertTrue(dis["disabled"])

        user = self.env["res.users"].browse(uid)
        self.assertFalse(user.active)

        keys = self.env["res.users.apikeys"].search([("user_id", "=", uid), ("name", "=", "iteso-gateway")])
        self.assertEqual(len(keys), 0)
