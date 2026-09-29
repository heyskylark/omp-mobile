/** @type {import('tailwindcss').Config} */
module.exports = {
	content: ["./src/**/*.{js,jsx,ts,tsx}"],
	presets: [require("nativewind/preset")],
	theme: {
		extend: {
			colors: {
				ink: "#0B0B0C",
				surface: "#141416",
				"surface-raised": "#1B1B1E",
				border: "#2A2A2E",
				primary: "#ECECEE",
				secondary: "#9A9AA2",
				accent: "#8B93FF",
				success: "#3FB950",
				warning: "#D29922",
				danger: "#F85149",
			},
			borderRadius: { card: "16px", panel: "20px" },
			fontSize: {
				body: ["15px", { lineHeight: "22px" }],
				caption: ["13px", { lineHeight: "18px" }],
			},
		},
	},
	plugins: [],
};
