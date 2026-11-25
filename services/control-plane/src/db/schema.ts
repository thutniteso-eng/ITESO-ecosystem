import {
  boolean,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

export const tenantStatusEnum = pgEnum('tenant_status', ['active', 'suspended']);
export const implementationStatusEnum = pgEnum('implementation_status', [
  'available',
  'not_implemented',
]);

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
