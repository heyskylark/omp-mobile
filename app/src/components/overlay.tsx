import { createContext, type PropsWithChildren, type ReactNode, useContext, useMemo, useRef, useState } from "react";

type OverlayContextValue = {
	/** Shows `node` above every screen; the returned function removes it unless another overlay replaced it. */
	present(node: ReactNode): () => void;
};
const OverlayContext = createContext<OverlayContextValue | null>(null);

/**
 * Hosts one full-window overlay inside the app's root view. Unlike a `Modal`, it presents no view controller,
 * so the focused text field keeps the keyboard up underneath it.
 */
export function OverlayProvider({ children }: PropsWithChildren) {
	const [node, setNode] = useState<ReactNode>(null);
	const current = useRef(0);
	const value = useMemo<OverlayContextValue>(
		() => ({
			present(next) {
				const id = ++current.current;
				setNode(next);
				return () => {
					if (current.current === id) setNode(null);
				};
			},
		}),
		[],
	);
	return (
		<OverlayContext.Provider value={value}>
			{children}
			{node}
		</OverlayContext.Provider>
	);
}

export function useOverlay() {
	const context = useContext(OverlayContext);
	if (!context) throw new Error("useOverlay must be used inside OverlayProvider");
	return context;
}
