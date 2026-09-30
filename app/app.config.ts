import type { ExpoConfig } from "expo/config";

const bundleIdentifier = process.env.OMP_BUNDLE_ID ?? "com.heyskylark.ompmobile";
const sharedSuffix = `${bundleIdentifier}.shared`;
// Free Apple accounts (Xcode Personal Teams) cannot sign the Push Notifications capability.
const personalTeam = process.env.OMP_PERSONAL_TEAM === "1";

const config: ExpoConfig = {
	name: "OMP",
	slug: "omp-mobile",
	version: "1.0.0",
	orientation: "portrait",
	icon: "./assets/icon.png",
	scheme: "ompmobile",
	userInterfaceStyle: "dark",
	experiments: { typedRoutes: true },
	owner: process.env.EXPO_OWNER,
	extra: { eas: { projectId: process.env.EAS_PROJECT_ID } },
	ios: {
		bundleIdentifier,
		appleTeamId: process.env.APPLE_TEAM_ID,
		supportsTablet: true,
		entitlements: {
			...(personalTeam ? {} : { "aps-environment": "development" }),
			"keychain-access-groups": [`$(AppIdentifierPrefix)${sharedSuffix}`],
			"com.apple.security.application-groups": [`group.${bundleIdentifier}`],
		},
		infoPlist: {
			NSCameraUsageDescription: "Scan an OMP computer pairing code.",
			NSAppTransportSecurity: {
				NSAllowsLocalNetworking: true,
				NSExceptionDomains: {
					"ts.net": {
						NSIncludesSubdomains: true,
						NSExceptionAllowsInsecureHTTPLoads: true,
					},
				},
			},
			UIBackgroundModes: ["remote-notification"],
			OmpKeychainAccessGroup: `$(AppIdentifierPrefix)${sharedSuffix}`,
		},
	},
	plugins: [
		"expo-router",
		[
			"expo-camera",
			{
				cameraPermission: "Scan an OMP computer pairing code.",
				recordAudioAndroid: false,
				barcodeScannerEnabled: true,
			},
		],
		"@bacons/apple-targets",
		["expo-build-properties", { ios: { deploymentTarget: "16.0" } }],
		"./plugins/with-pod-deployment-target",
	],
};

export default config;
