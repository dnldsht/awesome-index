CREATE TABLE `awesome_item` (
	`list_id` text NOT NULL,
	`repo_id` text NOT NULL,
	`section` text NOT NULL,
	`section_slug` text NOT NULL,
	`note` text,
	`position` integer NOT NULL,
	PRIMARY KEY(`list_id`, `repo_id`, `section_slug`),
	FOREIGN KEY (`list_id`) REFERENCES `awesome_list`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `awesome_item_repo_idx` ON `awesome_item` (`repo_id`);--> statement-breakpoint
CREATE INDEX `awesome_item_section_idx` ON `awesome_item` (`list_id`,`section_slug`);--> statement-breakpoint
CREATE TABLE `awesome_list` (
	`id` text PRIMARY KEY NOT NULL,
	`readme_digest` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `github_repo` (
	`id` text PRIMARY KEY NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`topics` text NOT NULL,
	`owner_login` text NOT NULL,
	`owner_avatar_url` text NOT NULL,
	`stars` integer NOT NULL,
	`forks` integer NOT NULL,
	`license` text,
	`primary_language` text DEFAULT '' NOT NULL,
	`archived` integer DEFAULT false NOT NULL,
	`pushed_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`refreshed_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `github_repo_stars_idx` ON `github_repo` (`stars`);--> statement-breakpoint
CREATE INDEX `github_repo_pushed_idx` ON `github_repo` (`pushed_at`);