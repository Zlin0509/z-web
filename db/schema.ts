import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';

export const notebookState = sqliteTable('notebook_state', {
  key: text('key').primaryKey(), value: text('value').notNull(),
});
export const notes = sqliteTable('notes', {
  id: text('id').primaryKey(),
  slug: text('slug').notNull().unique(),
  draftJson: text('draft_json').notNull(),
  publishedJson: text('published_json'),
  revision: integer('revision').notNull().default(1),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  publishedAt: text('published_at'),
  deletedAt: text('deleted_at'),
  lastMutation: text('last_mutation').notNull(),
});
export const noteVersions = sqliteTable('note_versions', {
  id: text('id').primaryKey(),
  noteId: text('note_id').notNull().references(() => notes.id),
  revision: integer('revision').notNull(),
  documentJson: text('document_json').notNull(),
  action: text('action').notNull(),
  createdAt: text('created_at').notNull(),
}, table => [index('versions_note_index').on(table.noteId, table.revision)]);
