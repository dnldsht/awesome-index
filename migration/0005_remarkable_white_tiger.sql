CREATE TABLE `history_fetch` (
	`target_id` text PRIMARY KEY NOT NULL,
	`pages_done` integer DEFAULT 0 NOT NULL,
	`etag_page1` text,
	`fetched_at` integer,
	`gone` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE `star_history` (
	`target_id` text NOT NULL,
	`week` integer NOT NULL,
	`delta` integer NOT NULL,
	PRIMARY KEY(`target_id`, `week`)
);
--> statement-breakpoint
ALTER TABLE `target` ADD `database_id` integer;