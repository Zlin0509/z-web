CREATE TABLE `note_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`note_id` text NOT NULL,
	`revision` integer NOT NULL,
	`document_json` text NOT NULL,
	`action` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`note_id`) REFERENCES `notes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `versions_note_index` ON `note_versions` (`note_id`,`revision`);--> statement-breakpoint
CREATE TABLE `notebook_state` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `notes` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`draft_json` text NOT NULL,
	`published_json` text,
	`revision` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`published_at` text,
	`deleted_at` text,
	`last_mutation` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notes_slug_unique` ON `notes` (`slug`);