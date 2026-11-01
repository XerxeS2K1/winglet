// The built-in Google push receiver (embedded UnifiedPush FCM distributor) asks Google Play services for a
// token the classic way, which Google only answers for apps that declare this permission. The Firebase SDK
// adds it for you; the embedded distributor does not.
const { AndroidConfig } = require('expo/config-plugins');

module.exports = function withEmbeddedFcm(config) {
  return AndroidConfig.Permissions.withPermissions(config, ['com.google.android.c2dm.permission.RECEIVE']);
};
