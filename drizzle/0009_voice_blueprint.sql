ALTER TABLE `voiceSessions` MODIFY COLUMN `proposalType`
  ENUM('lookup_contact','add_note','create_follow_up','unsupported','blueprint_action') NULL;
