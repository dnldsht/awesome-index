/*
 Written by hand rather than generated: drizzle-kit cannot tell a rename from a
 drop-and-create without asking, and its answer for both tables here is a table
 that starts empty. These statements carry the 34,808 target rows and 39,363
 item rows across, since re-crawling them costs a token and ~250 GraphQL calls.

 Both tables are rebuilt rather than altered because sqlite cannot drop a NOT
 NULL: stars, forks, pushed_at and the owner columns all become nullable, which
 is the point of the change. `stars = 0` is a repository nobody starred; null is
 a website, which has no stars to have.
*/
CREATE TABLE `target` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`url` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`stars` integer,
	`forks` integer,
	`license` text,
	`primary_language` text,
	`archived` integer,
	`last_activity_at` integer,
	`created_at` integer,
	`homepage_url` text,
	`topics` text,
	`owner_login` text,
	`owner_avatar_url` text,
	`status` text,
	`checked_at` integer,
	`last_ok_at` integer,
	`fail_streak` integer DEFAULT 0 NOT NULL,
	`refreshed_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `target` (
	`id`, `kind`, `url`, `description`, `stars`, `forks`, `license`,
	`primary_language`, `archived`, `last_activity_at`, `created_at`,
	`homepage_url`, `topics`, `owner_login`, `owner_avatar_url`,
	`fail_streak`, `refreshed_at`
)
SELECT
	`id`,
	'github',
	'https://github.com/' || `id`,
	`description`,
	`stars`,
	`forks`,
	`license`,
	nullif(`primary_language`, ''),
	`archived`,
	`pushed_at`,
	`created_at`,
	`homepage_url`,
	`topics`,
	`owner_login`,
	`owner_avatar_url`,
	0,
	`refreshed_at`
FROM `github_repo`;
--> statement-breakpoint
DROP TABLE `github_repo`;
--> statement-breakpoint
CREATE INDEX `target_stars_idx` ON `target` (`stars`);--> statement-breakpoint
CREATE INDEX `target_activity_idx` ON `target` (`last_activity_at`);--> statement-breakpoint
CREATE INDEX `target_kind_idx` ON `target` (`kind`);--> statement-breakpoint
CREATE TABLE `__new_awesome_item` (
	`list_id` text NOT NULL,
	`target_id` text NOT NULL,
	`section` text NOT NULL,
	`section_slug` text NOT NULL,
	`title` text,
	`note` text,
	`position` integer NOT NULL,
	PRIMARY KEY(`list_id`, `target_id`, `section_slug`),
	FOREIGN KEY (`list_id`) REFERENCES `awesome_list`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_awesome_item` (
	`list_id`, `target_id`, `section`, `section_slug`, `note`, `position`
)
SELECT `list_id`, `repo_id`, `section`, `section_slug`, `note`, `position`
FROM `awesome_item`;
--> statement-breakpoint
DROP TABLE `awesome_item`;
--> statement-breakpoint
ALTER TABLE `__new_awesome_item` RENAME TO `awesome_item`;
--> statement-breakpoint
CREATE INDEX `awesome_item_target_idx` ON `awesome_item` (`target_id`);--> statement-breakpoint
CREATE INDEX `awesome_item_section_idx` ON `awesome_item` (`list_id`,`section_slug`);
