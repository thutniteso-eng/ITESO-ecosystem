# -*- coding: utf-8 -*-
import datetime
import logging
from odoo import api, fields, models
from odoo.exceptions import AccessError, ValidationError

_logger = logging.getLogger(__name__)

# Only non-elevated user groups are permitted for automated provisioning
ALLOWED_GROUP_XMLIDS = {
    "base.group_user",
}

DISALLOWED_GROUP_XMLIDS = {
    "base.group_system",
    "base.group_erp_manager",
}


class ItesoProvisioning(models.AbstractModel):
    _name = "iteso.provisioning"
    _description = "ITESO Automated Member Provisioning Service"

    def _check_caller_permissions(self):
        """Ensure caller is strictly iteso_system and has base.group_system."""
        current_user = self.env.user
        if not (current_user.login == "iteso_system" and current_user.has_group("base.group_system")):
            _logger.warning("Access denied to iteso.provisioning for user %s (uid %s)", current_user.login, current_user.id)
            raise AccessError("Access denied: only iteso_system can call iteso.provisioning methods.")

    def _check_member_user(self, user):
        """Ensure target user is a member account (login starts with iteso- and is not iteso_system)."""
        if not user.login or not user.login.startswith("iteso-") or user.login == "iteso_system":
            raise AccessError("Operation allowed only on iteso-* member accounts.")

    @api.model
    def provision_member(self, membership_id, name, group_xmlids=None):
        """
        Create or update res.users with login iteso-<membership_id>.
        Sets active = True, display name, and assigned groups.
        Idempotent: calling multiple times will not duplicate records.
        """
        self._check_caller_permissions()

        if not membership_id:
            raise ValidationError("membership_id is required.")

        group_xmlids = group_xmlids or ["base.group_user"]

        # Validate groups against whitelist
        for xmlid in group_xmlids:
            if xmlid in DISALLOWED_GROUP_XMLIDS:
                raise AccessError(f"Group '{xmlid}' is forbidden for member provisioning.")
            if xmlid not in ALLOWED_GROUP_XMLIDS:
                raise ValidationError(f"Group '{xmlid}' is not in the allowed provisioning whitelist.")

        login = f"iteso-{membership_id}"
        Users = self.env["res.users"].sudo().with_context(active_test=False)
        existing = Users.search([("login", "=", login)], limit=1)

        # Resolve group records
        groups = self.env["res.groups"]
        for xmlid in group_xmlids:
            group = self.env.ref(xmlid, raise_if_not_found=False)
            if not group:
                raise ValidationError(f"Group XMLID '{xmlid}' not found.")
            groups |= group

        vals = {
            "name": name,
            "login": login,
            "active": True,
            "group_ids": [(6, 0, groups.ids)],
        }

        if existing:
            existing.write(vals)
            user = existing
        else:
            user = Users.create(vals)

        return {
            "uid": user.id,
            "login": user.login,
        }

    @api.model
    def issue_member_key(self, uid, ttl_days=90):
        """
        Issue a new API key (scope 'rpc', name 'iteso-gateway') for the given user uid with ttl_days.
        Returns the raw key ONCE along with its expiration timestamp.
        """
        self._check_caller_permissions()

        user = self.env["res.users"].sudo().browse(uid)
        if not user.exists():
            raise ValidationError(f"User with uid {uid} does not exist.")
        self._check_member_user(user)

        ttl_days = int(ttl_days) if ttl_days else 90
        expiration_date = datetime.datetime.now() + datetime.timedelta(days=ttl_days)

        # Generate key using Odoo standard API key mechanism
        # Using sudo() as iteso_system to allow issuing keys on behalf of the member user
        raw_key = self.env["res.users.apikeys"].with_user(user).sudo()._generate(
            scope="rpc",
            name="iteso-gateway",
            expiration_date=expiration_date,
        )

        return {
            "key": raw_key,
            "expires_at": fields.Datetime.to_string(expiration_date),
        }

    @api.model
    def revoke_member_keys(self, uid, keep_newest=True):
        """
        Revoke iteso-gateway API keys for user uid.
        If keep_newest is True, preserve the single newest key (used during rotation).
        """
        self._check_caller_permissions()

        user = self.env["res.users"].sudo().browse(uid)
        if not user.exists():
            raise ValidationError(f"User with uid {uid} does not exist.")
        self._check_member_user(user)

        keys = self.env["res.users.apikeys"].sudo().search(
            [("user_id", "=", uid), ("scope", "=", "rpc"), ("name", "=", "iteso-gateway")],
            order="create_date desc, id desc",
        )

        to_remove = keys[1:] if keep_newest else keys
        removed_count = len(to_remove)
        for k in to_remove:
            k._remove()

        return {"removed": removed_count}

    @api.model
    def disable_member(self, uid):
        """
        Deactivate member user (active = False) and revoke all their iteso-gateway API keys.
        """
        self._check_caller_permissions()

        user = self.env["res.users"].sudo().browse(uid)
        if not user.exists():
            return {"disabled": False, "reason": "not_found"}
        self._check_member_user(user)

        user.write({"active": False})

        # Remove all iteso-gateway API keys
        keys = self.env["res.users.apikeys"].sudo().search(
            [("user_id", "=", uid), ("scope", "=", "rpc"), ("name", "=", "iteso-gateway")]
        )
        for k in keys:
            k._remove()

        return {"disabled": True, "uid": uid}
