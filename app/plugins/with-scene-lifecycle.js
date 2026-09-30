const fs = require("node:fs");
const path = require("node:path");
const {
	IOSConfig,
	withAppDelegate,
	withDangerousMod,
	withInfoPlist,
	withPlugins,
	withXcodeProject,
} = require("expo/config-plugins");

// Adopts the UIKit scene life cycle. UIKit on iOS 27 traps at launch
// (_UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption) in apps without a scene manifest,
// and the Expo SDK 55 template still creates its window in the app delegate. SDK 58 generates this
// setup itself, so drop this plugin when upgrading.
const SCENE_DELEGATE = "SceneDelegate.swift";
const LEGACY_STARTUP = `#if os(iOS) || os(tvOS)
    window = UIWindow(frame: UIScreen.main.bounds)
    factory.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: launchOptions)
#endif

`;
const SCENE_STARTUP = "    // SceneDelegate creates the window and starts React Native.\n\n";

const withSceneManifest = (config) =>
	withInfoPlist(config, (config) => {
		config.modResults.UIApplicationSceneManifest = {
			UIApplicationSupportsMultipleScenes: false,
			UISceneConfigurations: {
				UIWindowSceneSessionRoleApplication: [
					{
						UISceneConfigurationName: "Default Configuration",
						UISceneDelegateClassName: "$(PRODUCT_MODULE_NAME).SceneDelegate",
					},
				],
			},
		};
		return config;
	});

const withSceneStartup = (config) =>
	withAppDelegate(config, (config) => {
		const appDelegate = config.modResults.contents;
		if (appDelegate.includes(SCENE_STARTUP)) return config;
		if (config.modResults.language !== "swift" || !appDelegate.includes(LEGACY_STARTUP)) {
			throw new Error("AppDelegate.swift does not match the Expo SDK 55 template");
		}
		config.modResults.contents = appDelegate.replace(LEGACY_STARTUP, SCENE_STARTUP);
		return config;
	});

const withSceneDelegateFile = (config) =>
	withDangerousMod(config, [
		"ios",
		(config) => {
			const { platformProjectRoot, projectName } = config.modRequest;
			fs.copyFileSync(
				path.join(__dirname, "scene-lifecycle", SCENE_DELEGATE),
				path.join(platformProjectRoot, projectName, SCENE_DELEGATE),
			);
			return config;
		},
	]);

const withSceneDelegateSource = (config) =>
	withXcodeProject(config, (config) => {
		const { projectName } = config.modRequest;
		config.modResults = IOSConfig.XcodeUtils.addBuildSourceFileToGroup({
			filepath: `${projectName}/${SCENE_DELEGATE}`,
			groupName: projectName,
			project: config.modResults,
		});
		return config;
	});

module.exports = (config) =>
	withPlugins(config, [
		withSceneManifest,
		withSceneStartup,
		withSceneDelegateFile,
		withSceneDelegateSource,
	]);
