CREATE TABLE `studioRecords` (
  `id` VARCHAR(36) NOT NULL,
  `workspaceId` VARCHAR(36) NOT NULL,
  `objectKey` VARCHAR(64) NOT NULL,
  `data` JSON NOT NULL,
  `createdAt` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `deletedAt` DATETIME NULL,
  PRIMARY KEY (`id`),
  INDEX `idx_workspace_object` (`workspaceId`, `objectKey`),
  INDEX `idx_workspace_deleted` (`workspaceId`, `deletedAt`),
  CONSTRAINT `fk_studio_records_workspace` FOREIGN KEY (`workspaceId`)
    REFERENCES `studioWorkspaces`(`id`) ON DELETE CASCADE
);
