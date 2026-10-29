import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
export const state = sqliteTable('service_state', {key:text('key').primaryKey(),value:text('value').notNull()});
export const assets = sqliteTable('assets', {id:text('id').primaryKey(),symbol:text('symbol').notNull(),market:text('market').notNull(),source:text('source').notNull(),data:text('data').notNull().default('[]'),status:text('status').notNull().default('empty'),message:text('message'),updated:text('updated'),revision:integer('revision').notNull().default(0)});
export const runs = sqliteTable('backtests', {id:text('id').primaryKey(),assetId:text('asset_id').notNull(),created:text('created').notNull(),result:text('result').notNull()});
export const sessions = sqliteTable('paper_sessions', {id:text('id').primaryKey(),assetId:text('asset_id').notNull(),created:text('created').notNull(),status:text('status').notNull(),revision:integer('revision').notNull().default(0),data:text('data').notNull()});
export const events = sqliteTable('events', {id:text('id').primaryKey(),created:text('created').notNull(),kind:text('kind').notNull(),detail:text('detail').notNull()});
export const analyses = sqliteTable('analyses', {id:text('id').primaryKey(),assetId:text('asset_id').notNull(),created:text('created').notNull(),data:text('data').notNull()});
