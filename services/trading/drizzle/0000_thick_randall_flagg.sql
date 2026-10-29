CREATE TABLE `analyses` (
	`id` text PRIMARY KEY NOT NULL,
	`asset_id` text NOT NULL,
	`created` text NOT NULL,
	`data` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `assets` (
	`id` text PRIMARY KEY NOT NULL,
	`symbol` text NOT NULL,
	`market` text NOT NULL,
	`source` text NOT NULL,
	`data` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'empty' NOT NULL,
	`message` text,
	`updated` text,
	`revision` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`created` text NOT NULL,
	`kind` text NOT NULL,
	`detail` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `backtests` (
	`id` text PRIMARY KEY NOT NULL,
	`asset_id` text NOT NULL,
	`created` text NOT NULL,
	`result` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `paper_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`asset_id` text NOT NULL,
	`created` text NOT NULL,
	`status` text NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`data` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `service_state` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
