import type { SkillCommand } from "@omp-mobile/protocol";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";
import { Icon } from "./ui";

// About four and a half rows, so a longer list visibly scrolls.
const MAX_HEIGHT = 236;

/** Skills matching the `/skill:` token being typed; tapping one completes the command. */
export function SkillMenu({ skills, onPick }: { skills: readonly SkillCommand[]; onPick(name: string): void }) {
	return (
		<Animated.View
			entering={FadeIn.duration(120)}
			exiting={FadeOut.duration(120)}
			style={styles.menu}
			accessibilityLabel="Skill suggestions"
		>
			<ScrollView keyboardShouldPersistTaps="always" style={styles.scroll} contentContainerStyle={styles.content}>
				{skills.map((skill) => (
					<Pressable
						key={skill.name}
						accessibilityRole="button"
						accessibilityLabel={`Skill ${skill.name}`}
						onPress={() => onPick(skill.name)}
						className="flex-row items-center gap-3 rounded-[14px] px-3 py-2 active:bg-surface-raised"
					>
						<Icon name="sparkles" size={15} color="#8B93FF" />
						<View className="flex-1">
							<Text numberOfLines={1} className="text-body text-primary">
								<Text className="text-secondary">/skill:</Text>
								<Text className="font-semibold">{skill.name}</Text>
							</Text>
							{skill.description ? (
								<Text numberOfLines={1} className="text-caption text-secondary">
									{skill.description}
								</Text>
							) : null}
						</View>
					</Pressable>
				))}
			</ScrollView>
		</Animated.View>
	);
}

const styles = StyleSheet.create({
	menu: {
		borderRadius: 20,
		borderWidth: 1,
		borderColor: "#2A2A2E",
		backgroundColor: "#141416",
		marginBottom: 6,
		overflow: "hidden",
	},
	scroll: { maxHeight: MAX_HEIGHT },
	content: { padding: 4 },
});
