const { PROTOCOL, PROTOCOL_VERSION } = require('./contracts');

const DEVICE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function deviceAudienceId(userId, deviceId) {
  return Buffer.from(`${userId}\u0000${deviceId}`, 'utf8').toString('base64url');
}

function deviceRoomName(userId, deviceId) {
  return `e2ee:v2:device:${deviceAudienceId(userId, deviceId)}`;
}

function isActiveV2Device(device) {
  return Boolean(
    device
    && device.status === 'active'
    && device.protocol === PROTOCOL
    && device.protocolVersion === PROTOCOL_VERSION
    && device.capabilities?.messageEncryption === true,
  );
}

async function verifySocketDevice({ database, userId, deviceId }) {
  if (!DEVICE_ID_PATTERN.test(String(deviceId || ''))) {
    throw new Error('v2_socket_device_invalid');
  }

  const snapshot = await database.collection('users').doc(userId)
    .collection('devices').doc(deviceId).get();
  if (!snapshot.exists || !isActiveV2Device(snapshot.data())) {
    throw new Error('v2_socket_device_not_authorized');
  }

  return {
    deviceId,
    platform: snapshot.data().platform,
    room: deviceRoomName(userId, deviceId),
  };
}

module.exports = {
  deviceAudienceId,
  deviceRoomName,
  isActiveV2Device,
  verifySocketDevice,
};
