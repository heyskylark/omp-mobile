import { createContext, type PropsWithChildren, useCallback, useContext, useMemo, useRef, useState } from "react";
import { Text, View } from "react-native";

type ToastContextValue = { show(message: string, tone?: "info" | "error"): void };
const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: PropsWithChildren) {
	const [toast, setToast] = useState<{ message: string; tone: "info" | "error" } | null>(null);
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const show = useCallback((message: string, tone: "info" | "error" = "info") => {
		clearTimeout(timer.current);
		setToast({ message, tone });
		timer.current = setTimeout(() => setToast(null), 3500);
	}, []);
	const value = useMemo(() => ({ show }), [show]);
	return (
		<ToastContext.Provider value={value}>
			{children}
			{toast ? (
				<View
					pointerEvents="none"
					className={`absolute left-5 right-5 top-14 rounded-card border px-4 py-3 ${toast.tone === "error" ? "border-danger bg-[#2A1415]" : "border-border bg-surface-raised"}`}
				>
					<Text numberOfLines={3} className="text-center text-[14px] font-medium text-primary">
						{toast.message}
					</Text>
				</View>
			) : null}
		</ToastContext.Provider>
	);
}

export function useToast() {
	const context = useContext(ToastContext);
	if (!context) throw new Error("useToast must be used inside ToastProvider");
	return context;
}
