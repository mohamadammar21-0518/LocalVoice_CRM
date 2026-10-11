CREATE TABLE `auditEvents` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`sessionId` int,
	`event` varchar(80) NOT NULL,
	`payload` text NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `auditEvents_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `hubspotSyncJobs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`kind` enum('contact','note','task') NOT NULL,
	`localId` int NOT NULL,
	`status` enum('running','succeeded','failed','uncertain') NOT NULL,
	`remoteId` varchar(64),
	`error` varchar(250),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `hubspotSyncJobs_id` PRIMARY KEY(`id`),
	CONSTRAINT `hubspot_job_entity` UNIQUE(`userId`,`kind`,`localId`)
);
--> statement-breakpoint
CREATE TABLE `voiceMetrics` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`requestId` varchar(36) NOT NULL,
	`sessionId` int,
	`stage` enum('stt','intent','retrieval','first_audio','turn','confirm','playback') NOT NULL,
	`outcome` enum('ok','error','cancelled') NOT NULL,
	`durationMs` int NOT NULL,
	`inputTokens` int NOT NULL DEFAULT 0,
	`outputTokens` int NOT NULL DEFAULT 0,
	`loadMs` int NOT NULL DEFAULT 0,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `voiceMetrics_id` PRIMARY KEY(`id`),
	CONSTRAINT `metrics_request_stage` UNIQUE(`userId`,`requestId`,`stage`)
);
--> statement-breakpoint
ALTER TABLE `users` ADD `passwordHash` varchar(255);--> statement-breakpoint
ALTER TABLE `users` ADD `sessionVersion` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `voiceSessions` ADD `proposalVersion` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `voiceSessions` ADD `confirmedResultJson` text;--> statement-breakpoint
ALTER TABLE `voiceSessions` ADD `sttLatencyMs` int;--> statement-breakpoint
ALTER TABLE `contacts` ADD CONSTRAINT `contacts_owner_id` UNIQUE(`userId`,`id`);--> statement-breakpoint
ALTER TABLE `contacts` ADD CONSTRAINT `contacts_owner_hubspot` UNIQUE(`userId`,`hubspotId`);--> statement-breakpoint
ALTER TABLE `followUpTasks` ADD CONSTRAINT `tasks_owner_hubspot` UNIQUE(`userId`,`hubspotId`);--> statement-breakpoint
ALTER TABLE `interactions` ADD CONSTRAINT `interactions_owner_hubspot` UNIQUE(`userId`,`hubspotId`);--> statement-breakpoint
ALTER TABLE `recordings` ADD CONSTRAINT `recordings_storage_key` UNIQUE(`storageKey`);--> statement-breakpoint
ALTER TABLE `voiceSessions` ADD CONSTRAINT `sessions_owner_id` UNIQUE(`userId`,`id`);--> statement-breakpoint
ALTER TABLE `auditEvents` ADD CONSTRAINT `audit_user_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `hubspotSyncJobs` ADD CONSTRAINT `hubspot_jobs_user_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `voiceMetrics` ADD CONSTRAINT `metrics_user_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `audit_owner_created` ON `auditEvents` (`userId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `metrics_owner_created` ON `voiceMetrics` (`userId`,`createdAt`);--> statement-breakpoint
ALTER TABLE `contacts` ADD CONSTRAINT `contacts_user_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `followUpTasks` ADD CONSTRAINT `tasks_contact_owner_fk` FOREIGN KEY (`userId`,`contactId`) REFERENCES `contacts`(`userId`,`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `interactions` ADD CONSTRAINT `interactions_contact_owner_fk` FOREIGN KEY (`userId`,`contactId`) REFERENCES `contacts`(`userId`,`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `recordings` ADD CONSTRAINT `recordings_user_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `recordings` ADD CONSTRAINT `recordings_session_owner_fk` FOREIGN KEY (`userId`,`voiceSessionId`) REFERENCES `voiceSessions`(`userId`,`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `voiceSessions` ADD CONSTRAINT `sessions_user_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `contacts_owner_name` ON `contacts` (`userId`,`firstName`,`lastName`);--> statement-breakpoint
CREATE INDEX `tasks_owner_status_due` ON `followUpTasks` (`userId`,`status`,`dueAt`);--> statement-breakpoint
CREATE INDEX `tasks_owner_contact` ON `followUpTasks` (`userId`,`contactId`);--> statement-breakpoint
CREATE INDEX `interactions_owner_contact_date` ON `interactions` (`userId`,`contactId`,`occurredAt`);--> statement-breakpoint
CREATE INDEX `recordings_owner_created` ON `recordings` (`userId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `sessions_owner_created` ON `voiceSessions` (`userId`,`createdAt`);