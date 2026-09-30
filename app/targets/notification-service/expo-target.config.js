/** @type {import('@bacons/apple-targets/app.plugin').ConfigFunction} */
module.exports = (config) => {
  const bundleId = process.env.OMP_BUNDLE_ID || config.ios.bundleIdentifier || "com.heyskylark.ompmobile";
  return {
    type: "notification-service",
    name: "OmpNotificationService",
    displayName: "OMP Notification Service",
    bundleIdentifier: ".notification-service",
    deploymentTarget: "16.0",
    frameworks: ["CryptoKit", "Security", "UserNotifications"],
    entitlements: {
      "keychain-access-groups": [`$(AppIdentifierPrefix)${bundleId}.shared`],
      "com.apple.security.application-groups": [`group.${bundleId}`],
    },
  };
};
