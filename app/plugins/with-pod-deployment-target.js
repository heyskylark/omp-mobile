const { withPodfile } = require("expo/config-plugins");

// Raises every pod target below the app's deployment target to match it. Xcode 27 rejects
// targets below iOS 15.0 (the RNSVG and SDWebImage resource bundles declare 12.4 and 9.0),
// and the iOS 27 SDK needs iOS 16 for APIs that expo-router 55 uses without availability checks.
const MARKER = "# omp-mobile: raise pod deployment targets";
const HOOK = /^( *)post_install do \|installer\|\n/m;

module.exports = function withPodDeploymentTarget(config) {
	return withPodfile(config, (config) => {
		const podfile = config.modResults.contents;
		if (podfile.includes(MARKER)) return config;
		if (!HOOK.test(podfile)) throw new Error("Podfile has no post_install hook to extend");
		config.modResults.contents = podfile.replace(HOOK, (line, indent) =>
			[
				MARKER,
				"minimum = Gem::Version.new(podfile_properties['ios.deploymentTarget'] || '15.1')",
				"installer.pods_project.targets.each do |target|",
				"  target.build_configurations.each do |build_config|",
				"    current = build_config.build_settings['IPHONEOS_DEPLOYMENT_TARGET']",
				"    if current && Gem::Version.new(current) < minimum",
				"      build_config.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = minimum.to_s",
				"    end",
				"  end",
				"end",
			]
				.map((text) => `${indent}  ${text}\n`)
				.reduce((body, text) => body + text, line),
		);
		return config;
	});
};
