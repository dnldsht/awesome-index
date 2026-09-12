ALTER TABLE `target` ADD `popularity` integer;--> statement-breakpoint
ALTER TABLE `target` ADD `popularity_source` text;--> statement-breakpoint
ALTER TABLE `target` ADD `popularity_ref` text;--> statement-breakpoint
ALTER TABLE `target` ADD `popularity_raw` integer;--> statement-breakpoint
CREATE INDEX `target_popularity_idx` ON `target` (`popularity`);