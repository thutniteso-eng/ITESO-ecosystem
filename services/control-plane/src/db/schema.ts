import {
  boolean,
  check,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const tenantStatusEnum = pgEnum('tenant_status', ['active', 'suspended']);
export const implementationStatusEnum = pgEnum('implementation_status', [
  'available',
  'not_implemented',
]);
export const accountStatusEnum = pgEnum('account_status', ['active', 'disabled']);
export const membershipStatusEnum = pgEnum('membership_status', ['active', 'disabled']);

export const tenants = pgTable('tenants', {
  id: uuid('id').defaultRandom().primaryKey(),
  code: text('code').notNull().unique(),
  dbName: text('db_name').notNull().unique(),
  displayName: text('display_name').notNull(),
  status: tenantStatusEnum('status').default('active').notNull(),
  industries: text('industries').array().notNull().default([]),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const featureDefinitions = pgTable('feature_definitions', {
  key: text('key').primaryKey(),
  group: text('group').notNull(),
  description: text('description').notNull(),
  implementationStatus: implementationStatusEnum('implementation_status')
    .default('not_implemented')
    .notNull(),
  platformEnabled: boolean('platform_enabled').default(false).notNull(),
  defaultEnabled: boolean('default_enabled').default(false).notNull(),
});

export const tenantFeatures = pgTable(
  'tenant_features',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    featureKey: text('feature_key')
      .notNull()
      .references(() => featureDefinitions.key, { onDelete: 'cascade' }),
    enabled: boolean('enabled').notNull(),
    updatedBy: text('updated_by').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    note: text('note'),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.featureKey] }),
  ],
);

export const adminAuditLog = pgTable('admin_audit_log', {
  id: uuid('id').defaultRandom().primaryKey(),
  actor: text('actor').notNull(),
  action: text('action').notNull(),
  targetType: text('target_type').notNull(),
  targetId: text('target_id').notNull(),
  before: jsonb('before'),
  after: jsonb('after'),
  note: text('note'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const accounts = pgTable(
  'accounts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    email: text('email').unique(),
    phone: text('phone').unique(),
    passwordHash: text('password_hash').notNull(),
    totpSecretEnc: text('totp_secret_enc'),
    totpEnabled: boolean('totp_enabled').default(false).notNull(),
    isPlatformAdmin: boolean('is_platform_admin').default(false).notNull(),
    status: accountStatusEnum('status').default('active').notNull(),
    failedAttempts: integer('failed_attempts').default(0).notNull(),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  () => [
    check('accounts_identifier_check', sql`email IS NOT NULL OR phone IS NOT NULL`),
  ],
);

export const permissions = pgTable('permissions', {
  key: text('key').primaryKey(),
  group: text('group').notNull(),
  description: text('description').notNull(),
});

export const roles = pgTable(
  'roles',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    isOwner: boolean('is_owner').default(false).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    unique('roles_tenant_id_name_unique').on(t.tenantId, t.name),
  ],
);

export const rolePermissions = pgTable(
  'role_permissions',
  {
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    permissionKey: text('permission_key')
      .notNull()
      .references(() => permissions.key, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.roleId, t.permissionKey] }),
  ],
);

export const memberships = pgTable(
  'memberships',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    status: membershipStatusEnum('status').default('active').notNull(),
    branchScope: text('branch_scope').array().default([]).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    unique('memberships_account_tenant_unique').on(t.accountId, t.tenantId),
  ],
);

export const membershipRoles = pgTable(
  'membership_roles',
  {
    membershipId: uuid('membership_id')
      .notNull()
      .references(() => memberships.id, { onDelete: 'cascade' }),
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.membershipId, t.roleId] }),
  ],
);

export const refreshTokens = pgTable('refresh_tokens', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: uuid('account_id')
    .notNull()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  membershipId: uuid('membership_id')
    .references(() => memberships.id, { onDelete: 'cascade' }),
  familyId: uuid('family_id').defaultRandom().notNull(),
  tokenHash: text('token_hash').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  replacedBy: uuid('replaced_by').references((): AnyPgColumn => refreshTokens.id, {
    onDelete: 'set null',
  }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  userAgent: text('user_agent'),
  ip: text('ip'),
});
