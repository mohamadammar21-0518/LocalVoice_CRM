CREATE TABLE `voiceLatencySamples` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`requestId` varchar(36) NOT NULL,
	`metric` varchar(48) NOT NULL,
	`durationMs` int NOT NULL,
	`language` varchar(8) NOT NULL,
	`engine` varchar(32) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `voiceLatencySamples_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `voiceLatencySamples` ADD CONSTRAINT `latency_user_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX `latency_owner_created` ON `voiceLatencySamples` (`userId`,`createdAt`);
--> statement-breakpoint
CREATE INDEX `latency_owner_metric` ON `voiceLatencySamples` (`userId`,`metric`);
