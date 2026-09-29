const path = require("path");

const expoPackage = require.resolve("expo/package.json");
const nativeWindPackage = require.resolve("nativewind/package.json");
const cssInteropRoot = path.dirname(
	require.resolve("react-native-css-interop/package.json", { paths: [nativeWindPackage] }),
);

// Bun's isolated install hides NativeWind's transitive Babel modules from the app root, so the
// `nativewind/babel` preset is expanded here with explicit resolution paths.
module.exports = function (api) {
	api.cache(true);
	return {
		presets: [[require.resolve("babel-preset-expo", { paths: [expoPackage] }), { jsxImportSource: "nativewind" }]],
		plugins: [
			require(path.join(cssInteropRoot, "dist/babel-plugin.js")).default,
			require.resolve("react-native-worklets/plugin"),
		],
	};
};
