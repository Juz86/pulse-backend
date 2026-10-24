const { groupMembershipHash } = require('./policy');

function initialGroupEpochFields(members) {
  return {
    e2eeGroupEpoch: 1,
    e2eeGroupMembershipHash: groupMembershipHash(members),
    e2eeGroupEpochState: 'rotation_required',
  };
}

function rotateGroupEpochFields(conversation, nextMembers, rotatedAt) {
  const currentEpoch = Number(conversation?.e2eeGroupEpoch || 0);
  return {
    e2eeGroupEpoch: Number.isSafeInteger(currentEpoch) && currentEpoch >= 1
      ? currentEpoch + 1
      : 1,
    e2eeGroupMembershipHash: groupMembershipHash(nextMembers),
    e2eeGroupEpochState: 'rotation_required',
    e2eeGroupEpochRotatedAt: rotatedAt,
  };
}

module.exports = { initialGroupEpochFields, rotateGroupEpochFields };
