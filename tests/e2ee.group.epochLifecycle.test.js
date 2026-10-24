const {
  initialGroupEpochFields,
  rotateGroupEpochFields,
} = require('../src/e2ee/group/epochLifecycle');
const { groupMembershipHash } = require('../src/e2ee/group/policy');

test('new groups start at epoch one and require sender-key distribution', () => {
  expect(initialGroupEpochFields(['user-b', 'user-a', 'user-a'])).toEqual({
    e2eeGroupEpoch: 1,
    e2eeGroupMembershipHash: groupMembershipHash(['user-a', 'user-b']),
    e2eeGroupEpochState: 'rotation_required',
  });
});

test('membership changes advance the epoch and bind the new member set', () => {
  expect(rotateGroupEpochFields(
    { e2eeGroupEpoch: 7 },
    ['user-a', 'user-c'],
    'server-ts',
  )).toEqual({
    e2eeGroupEpoch: 8,
    e2eeGroupMembershipHash: groupMembershipHash(['user-a', 'user-c']),
    e2eeGroupEpochState: 'rotation_required',
    e2eeGroupEpochRotatedAt: 'server-ts',
  });
});

test('legacy groups initialize safely on their first membership change', () => {
  expect(rotateGroupEpochFields({}, ['user-a', 'user-b'], 'server-ts')).toMatchObject({
    e2eeGroupEpoch: 1,
    e2eeGroupMembershipHash: groupMembershipHash(['user-a', 'user-b']),
  });
});
