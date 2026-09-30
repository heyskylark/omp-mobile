import { StyleSheet, Text } from "react-native";
import { SKILL_CHIP_ICON, type SkillSegment } from "../data/skill-draft";

/** Nested text runs for `segments`: plain text as is, skills as gold `✦ <name>` chips like OMP's terminal. */
export function SkillSegmentsText({ segments }: { segments: readonly SkillSegment[] }) {
	return segments.map((segment, index) =>
		segment.kind === "text" ? (
			<Text key={index}>{segment.text}</Text>
		) : (
			<Text key={index} style={styles.chip}>{`${SKILL_CHIP_ICON} ${segment.name}`}</Text>
		),
	);
}

const styles = StyleSheet.create({
	chip: { color: "#D4C090", backgroundColor: "#3A3220", fontWeight: "600" },
});
