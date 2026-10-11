CREATE TABLE `contacts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`firstName` varchar(100) NOT NULL,
	`lastName` varchar(100) NOT NULL,
	`company` varchar(160),
	`role` varchar(160),
	`email` varchar(320),
	`phone` varchar(60),
	`notes` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `contacts_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `followUpTasks` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`contactId` int NOT NULL,
	`title` varchar(240) NOT NULL,
	`dueAt` timestamp NOT NULL,
	`status` enum('open','completed') NOT NULL DEFAULT 'open',
	`completedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `followUpTasks_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `interactions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`contactId` int NOT NULL,
	`kind` enum('note','call','meeting','email') NOT NULL DEFAULT 'note',
	`body` text NOT NULL,
	`occurredAt` timestamp NOT NULL DEFAULT (now()),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `interactions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `recordings` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`voiceSessionId` int,
	`filename` varchar(255) NOT NULL,
	`mimeType` varchar(100) NOT NULL,
	`storageKey` varchar(500) NOT NULL,
	`storageUrl` varchar(1000) NOT NULL,
	`sizeBytes` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `recordings_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `voiceSessions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`transcript` text,
	`detectedLanguage` varchar(16),
	`proposalType` enum('lookup_contact','add_note','create_follow_up','unsupported'),
	`proposalJson` text,
	`status` enum('transcribed','proposed','confirmed','rejected') NOT NULL DEFAULT 'transcribed',
	`recordingKey` varchar(500),
	`recordingUrl` varchar(1000),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `voiceSessions_id` PRIMARY KEY(`id`)
);
