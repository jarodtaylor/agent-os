CREATE TABLE `access_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` text,
	`harness` text NOT NULL,
	`tool` text NOT NULL,
	`project` text NOT NULL,
	`ts` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `breadcrumbs` (
	`id` text PRIMARY KEY NOT NULL,
	`project` text NOT NULL,
	`session_id` text NOT NULL,
	`machine_id` text NOT NULL,
	`source` text NOT NULL,
	`kind` text NOT NULL,
	`summary` text NOT NULL,
	`ts` integer NOT NULL,
	`sensitivity` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `capture_cursor` (
	`source_path` text PRIMARY KEY NOT NULL,
	`byte_offset` integer NOT NULL,
	`updated_at` integer
);
--> statement-breakpoint
CREATE TABLE `handoffs` (
	`project` text NOT NULL,
	`session_id` text NOT NULL,
	`machine_id` text NOT NULL,
	`source` text NOT NULL,
	`cursor_in_flight` text NOT NULL,
	`cursor_last_decided` text NOT NULL,
	`cursor_next` text NOT NULL,
	`ts` integer NOT NULL,
	PRIMARY KEY(`project`, `session_id`)
);
--> statement-breakpoint
CREATE TABLE `inventory` (
	`runtime` text NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`machine_id` text NOT NULL,
	`source` text NOT NULL,
	PRIMARY KEY(`runtime`, `kind`, `name`, `machine_id`)
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`name` text PRIMARY KEY NOT NULL,
	`created_at` integer
);
