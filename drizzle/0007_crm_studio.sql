CREATE TABLE `studioWorkspaces` (
  `id` varchar(36) NOT NULL PRIMARY KEY,
  `name` varchar(120) NOT NULL,
  `document` mediumtext NOT NULL
);
CREATE TABLE `studioMembers` (
  `workspaceId` varchar(36) NOT NULL,
  `userId` int NOT NULL,
  `role` enum('owner','editor','viewer') NOT NULL,
  UNIQUE KEY `studio_member` (`workspaceId`, `userId`),
  KEY `studio_user` (`userId`)
);
ALTER TABLE `studioMembers` ADD CONSTRAINT `studio_workspace_fk` FOREIGN KEY (`workspaceId`) REFERENCES `studioWorkspaces` (`id`) ON DELETE CASCADE;
ALTER TABLE `studioMembers` ADD CONSTRAINT `studio_user_fk` FOREIGN KEY (`userId`) REFERENCES `users` (`id`) ON DELETE CASCADE;
